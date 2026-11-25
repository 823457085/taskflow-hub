import { useId, useState } from 'react';
import { AutoComplete, Input, Select } from 'antd';
import { ChevronDown } from 'lucide-react';
import { toolLabel } from './displayLabels';
import { readStoredChoice, readStoredString, readStoredStringList, writeStoredString, writeStoredStringList } from './uiPreferences';
import type { LocalAiEngineId, LocalAiRun, LocalAiRunner, LocalAutomationCapabilities, LocalAutomationEngine } from './workspaceApi';
import './LocalAiExecutionFields.css';

const ENGINE_KEY = 'taskflow.ai.engine';
const ENGINES: LocalAutomationEngine[] = [
  { id: 'codex', label: 'Codex CLI', tool: 'codex-cli', available: true },
  { id: 'antigravity', label: 'Gemini / Antigravity', tool: 'antigravity', available: true },
  { id: 'cursor', label: 'Cursor Agent', tool: 'cursor', available: true },
  { id: 'claude', label: 'Claude Code', tool: 'claude-code', available: true },
];
const ENGINE_IDS = ENGINES.map(item => item.id);
const CLI_DEFAULT = '__cli_default__';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:@+,\[\]=\-]{0,119}$/;

export const readAiEngine = () => readStoredChoice(ENGINE_KEY, ENGINE_IDS, 'codex');
export const readAiEngineOverride = () => readStoredChoice<LocalAiEngineId | ''>(ENGINE_KEY, ENGINE_IDS, '');
const saveAiEngine = (engine: LocalAiEngineId) => writeStoredString(ENGINE_KEY, engine);

export function availableAiEngine(capabilities: LocalAutomationCapabilities, preferred: LocalAiEngineId): LocalAiEngineId {
  if (capabilities.engines.some(item => item.id === preferred && item.available)) return preferred;
  return capabilities.engines.find(item => item.available)?.id || preferred;
}

export function useAiModelSelection(
  capabilities: LocalAutomationCapabilities | null,
  engine: LocalAiEngineId,
  runner: LocalAiRunner = 'local',
  deviceModels?: string[],
  deviceId?: string,
) {
  const key = ['taskflow.ai.model', runner, engine, deviceId].filter(Boolean).join('.');
  const historyKey = key + '.recent';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [recentByEngine, setRecentByEngine] = useState<Record<string, string[]>>({});
  const engineCapability = capabilities?.engines.find(item => item.id === engine);
  const supported = runner === 'workbench'
    ? capabilities?.apps.workbenchSupportsModel === true
    : runner === 'bridge'
      ? Boolean(deviceModels?.includes(engine))
      : engineCapability?.supportsModel === true && engineCapability.available;
  const defaultModel = runner === 'local' ? engineCapability?.defaultModel : undefined;
  const fallback = runner === 'workbench' ? '使用工作台默认模型' : runner === 'bridge' ? '使用设备默认模型' : '使用 CLI 默认模型';
  const value = supported ? drafts[key] ?? readStoredString(key) : '';
  const model = value.trim();
  const invalid = !!model && !MODEL_ID.test(model);
  const recent = recentByEngine[historyKey] ?? readStoredStringList(historyKey);
  const onChange = (next: string) => {
    setDrafts(current => ({ ...current, [key]: next }));
    const clean = next.trim();
    if (!clean || MODEL_ID.test(clean)) writeStoredString(key, clean);
  };
  const remember = (raw = model) => {
    const clean = raw.trim();
    if (!supported || !MODEL_ID.test(clean) || recent[0] === clean) return;
    const next = [clean, ...recent.filter(item => item !== clean && MODEL_ID.test(item))].slice(0, 8);
    setRecentByEngine(current => ({ ...current, [historyKey]: next }));
    writeStoredStringList(historyKey, next);
  };
  return {
    model,
    value,
    invalid,
    onChange,
    remember,
    recent,
    supported,
    fallback,
    defaultModel,
  };
}

export function aiRunModelLabel(run: Pick<LocalAiRun, 'model' | 'effectiveModel'>) {
  if (run.effectiveModel && run.model && run.effectiveModel !== run.model) {
    return `实际模型 ${run.effectiveModel} · 指定模型 ${run.model}`;
  }
  if (run.effectiveModel) return `实际模型 ${run.effectiveModel}`;
  if (run.model) return `指定模型 ${run.model}`;
  return '模型未记录';
}

export function AiRunIdentity({ run }: { run: LocalAiRun }) {
  const value = `${toolLabel(run.engine)} · ${aiRunModelLabel(run)}`;
  return <span className="tf-ai-run-identity" title={value}>{value}</span>;
}

export function LocalAiExecutionFields({
  capabilities, engine, onEngineChange, model, runner = 'local', disabled, size,
}: {
  capabilities: LocalAutomationCapabilities | null;
  engine: LocalAiEngineId;
  onEngineChange: (engine: LocalAiEngineId) => void;
  model: ReturnType<typeof useAiModelSelection>;
  runner?: LocalAiRunner;
  disabled?: boolean;
  size?: 'small' | 'middle';
}) {
  const engineId = useId();
  const modelId = useId();
  const available = runner === 'workbench'
    ? ENGINES.filter(item => item.id === 'codex' || item.id === 'cursor')
    : capabilities?.engines || ENGINES;
  const options = available.map(item => ({
    label: item.available ? item.label : `${item.label}（未安装）`,
    value: item.id,
    disabled: !item.available,
  }));
  const defaultText = model.defaultModel || model.fallback;
  // These aliases are accepted by Claude CLI itself; entitlement is decided at runtime.
  const aliases = engine === 'claude' ? ['sonnet', 'opus', 'fable'] : [];
  const knownModels = [...new Set([model.model, ...model.recent, ...aliases].filter(item => MODEL_ID.test(item)))];
  const modelOptions = [
    { value: CLI_DEFAULT, label: model.defaultModel ? `CLI 默认 · ${model.defaultModel}` : model.fallback },
    ...knownModels.map(id => ({ value: id, label: id })),
  ];

  return (
    <div className="tf-ai-execution-fields">
      <div className="tf-ai-execution-field">
        <label htmlFor={engineId}>CLI</label>
        <Select id={engineId} aria-label="CLI" size={size} value={engine} options={options} disabled={disabled}
          onChange={next => { saveAiEngine(next); onEngineChange(next); }} />
      </div>
      <div className="tf-ai-execution-field">
        <label htmlFor={modelId}>
          模型
          {model.invalid ? <span className="tf-ai-model-invalid" id={`${modelId}-error`}>模型标识无效</span> :
            model.defaultModel && !model.value && <span className="tf-ai-default-label">CLI 默认</span>}
        </label>
        {model.supported ? (
          <AutoComplete<string>
            id={modelId}
            aria-label="模型"
            aria-invalid={model.invalid || undefined}
            aria-describedby={model.invalid ? `${modelId}-error` : undefined}
            className={model.defaultModel ? 'tf-ai-known-model' : undefined}
            size={size}
            value={model.value}
            placeholder={defaultText}
            disabled={disabled}
            allowClear
            suffix={<ChevronDown size={13} aria-hidden="true" />}
            options={modelOptions}
            showSearch={{ filterOption: false }}
            defaultActiveFirstOption={false}
            status={model.invalid ? 'error' : undefined}
            onChange={next => model.onChange(next === CLI_DEFAULT ? '' : next)}
            onSelect={next => model.remember(next)}
            onBlur={() => model.remember()}
            onInputKeyDown={event => { if (event.key === 'Enter') model.remember(); }}
          />
        ) : (
          <Input id={modelId} aria-label="模型" size={size} value={defaultText} readOnly disabled={disabled} title={defaultText} />
        )}
      </div>
    </div>
  );
}
