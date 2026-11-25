import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Drawer, Dropdown, Empty, Flex, Form, Input, Modal, Popconfirm, Radio, Select, Space, Skeleton, Switch, Table, Tag, Typography } from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { Download, FileArchive, FileCode2, FileUp, FolderUp, Pencil, Plus, RefreshCw, ScanSearch, Sparkles, Trash2 } from 'lucide-react';
import { api, ApiError, SkillAttachmentFile, SkillScopeId, SkillScopeMeta, TeamSkillItem, User } from './workspaceApi';
import { MarkdownPreview } from './MarkdownPreview';
import './TeamSkillsView.css';

interface Revision {
  version: number;
  description: string;
  content: string;
  scopes?: SkillScopeId[];
  enabled: boolean;
  editedBy: string;
  editedAt: string;
}

interface SkillForm {
  name: string;
  title: string;
  description: string;
  scopes: SkillScopeId[];
  visibility: 'TEAM' | 'PERSONAL';
  content: string;
}

interface ImportCandidate {
  key: string;
  name: string;
  title?: string;
  description: string;
  content: string;
  scopes: SkillScopeId[];
  files: SkillAttachmentFile[];
  source: string;
  sourceLabel?: string;
  selected: boolean;
}

const DEFAULT_SCOPES: SkillScopeMeta[] = [
  { id: 'PRD_REVIEW', label: '需求评审', group: 'review', description: '评审 PRD 业务目标、边界条件、角色权限与可测 AC' },
  { id: 'JIRA_GEN', label: 'Jira 生成与拆解', group: 'generate', description: '从需求/方案拆解子任务、生成 Jira 标题、验收标准与排期' },
  { id: 'TECH_SPEC_GEN', label: '技术方案生成', group: 'generate', description: '基于需求与代码仓结构自动起草技术方案与接口设计' },
  { id: 'TECH_SPEC_REVIEW', label: '技术方案 / 接口评审', group: 'review', description: '评审架构合理性、接口契约兼容性、并发幂等与安全风险' },
  { id: 'CODE_GEN', label: '代码开发', group: 'generate', description: '指导 AI 编写功能代码、遵守分层规范与补齐单元测试' },
  { id: 'CODE_REVIEW', label: '代码评审', group: 'review', description: '审查 PR/MR 与本地 Diff 的代码质量、安全红线与门禁证据' },
  { id: 'TEST_CASE', label: '测试用例', group: 'quality', description: '生成或评审黑盒/边界/权限/回归测试用例集' },
  { id: 'RELEASE', label: '上线检查', group: 'quality', description: '核查上线依赖顺序、灰度策略、监控告警与回滚预案' },
];

const SCOPE_COLORS: Record<SkillScopeId, string> = {
  PRD_REVIEW: 'blue',
  JIRA_GEN: 'cyan',
  TECH_SPEC_GEN: 'geekblue',
  TECH_SPEC_REVIEW: 'purple',
  CODE_GEN: 'green',
  CODE_REVIEW: 'volcano',
  TEST_CASE: 'gold',
  RELEASE: 'magenta',
};

const SKILL_PAGE_SIZE = 20;
const when = (value: string) => new Date(value).toLocaleString();

export function parseSkillFile(content: string, fallbackName = '') {
  const text = content.replace(/^\uFEFF/, '');
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)?.[1] || '';
  const meta = (key: string) => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') || '';
  const name = (meta('name') || fallbackName).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  const rawDesc = meta('description').replace(/[\r\n]+/g, ' ').trim();
  const bodyFirstLine = text.replace(/^---[\s\S]*?---/, '').split(/\r?\n/).map(l => l.trim().replace(/^#+\s*/, '')).find(Boolean) || '';
  return {
    name: name || 'imported-skill',
    title: (meta('title') || text.replace(/^---[\s\S]*?---/, '').match(/^#\s+(.+)$/m)?.[1].trim() || name || '导入的 Skill').slice(0, 120),
    description: (rawDesc || bodyFirstLine || name || '导入的 Skill').slice(0, 500),
    content: text,
  };
}

function inferClientScopes(name: string, description: string): SkillScopeId[] {
  const positiveDesc = description.split(/[。；;!\n]+/).filter(seg => !/(不自动触发|不适用于|不用于|勿用于)/.test(seg)).join(' ');
  const hay = `${name} ${positiveDesc}`.toLowerCase();
  const out: SkillScopeId[] = [];
  if (/(code[\s_-]*review|代码评审|代码审查|pr[\s_-]*review|mr[\s_-]*review)/i.test(hay)) out.push('CODE_REVIEW');
  if (/(prd|需求评审|需求审查)/i.test(hay)) out.push('PRD_REVIEW');
  if (/(jira|子任务|拆解|breakdown|subtask)/i.test(hay)) out.push('JIRA_GEN');
  if (/(技术方案生成|技术方案编写|tech[\s_-]*spec[\s_-]*gen|tech[\s_-]*spec[\s_-]*writer)/i.test(hay)) out.push('TECH_SPEC_GEN');
  if (/(技术方案评审|技术方案与接口|方案评审|接口评审|openapi|swagger)/i.test(hay)) out.push('TECH_SPEC_REVIEW');
  if (/(代码开发|代码实现|编码规范|code[\s_-]*gen|code[\s_-]*impl)/i.test(hay)) out.push('CODE_GEN');
  if (/(测试用例|test[\s_-]*case)/i.test(hay)) out.push('TEST_CASE');
  if (/(上线检查|上线发布|上线准出|release)/i.test(hay)) out.push('RELEASE');
  return out;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export const TeamSkillsView: React.FC<{ user: User; onUnauthorized: () => void }> = ({ user, onUnauthorized }) => {
  const { message } = App.useApp();
  const [form] = Form.useForm<SkillForm>();
  const [skills, setSkills] = useState<TeamSkillItem[]>([]);
  const [scopeCatalog, setScopeCatalog] = useState<SkillScopeMeta[]>(DEFAULT_SCOPES);
  const [canManageTeam, setCanManageTeam] = useState(false);
  const [localDiscoverEnabled, setLocalDiscoverEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<string>('');
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(1);
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [failedDetailKey, setFailedDetailKey] = useState('');
  const [detail, setDetail] = useState<{ scope: string; item: TeamSkillItem }>();
  const [filePath, setFilePath] = useState('');
  const [revisionVersion, setRevisionVersion] = useState<number>();
  const [open, setOpen] = useState<TeamSkillItem | 'new' | null>(null);
  const [editing, setEditing] = useState(false);
  const [editFiles, setEditFiles] = useState<SkillAttachmentFile[]>([]);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<{ key: string; items: Revision[] }>();

  // Unified import preview modal state
  const [importOpen, setImportOpen] = useState(false);
  const [importTitle, setImportTitle] = useState('导入 Skills');
  const [importCandidates, setImportCandidates] = useState<ImportCandidate[]>([]);
  const [importVisibility, setImportVisibility] = useState<'TEAM' | 'PERSONAL'>('PERSONAL');
  const [importMode, setImportMode] = useState<'overwrite' | 'skip'>('overwrite');
  const [importing, setImporting] = useState(false);
  const [preparingImport, setPreparingImport] = useState(false);

  const singleFileInput = useRef<HTMLInputElement>(null);
  const refFileInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const multiMdJsonInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const scope = user.id;
  const [loadedScope, setLoadedScope] = useState('');
  const liveScope = useRef(scope);
  liveScope.current = scope;

  const scopeLabel = (id: SkillScopeId) => scopeCatalog.find(s => s.id === id)?.label || id;
  const defaultVisibility = canManageTeam ? 'TEAM' : 'PERSONAL';
  const libraryNames = (visibility: 'TEAM' | 'PERSONAL') =>
    new Set(skills.filter(skill => !skill.projectId && skill.visibility === visibility).map(skill => skill.name));

  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) { onUnauthorized(); return; }
    void message.error(error instanceof Error ? error.message : '请求失败。');
  };

  const refresh = async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const data = await api<{
        skills: TeamSkillItem[];
        canManage: boolean;
        scopes?: SkillScopeMeta[];
        localDiscoverEnabled?: boolean;
      }>('skills/library');
      if (request === sequence.current && liveScope.current === scope) {
        setSkills(data.skills);
        setLoadedScope(scope);
        setCanManageTeam(data.canManage);
        if (data.scopes?.length) setScopeCatalog(data.scopes);
        setLocalDiscoverEnabled(!!data.localDiscoverEnabled);
      }
    } catch (error) { if (request === sequence.current && liveScope.current === scope) fail(error); }
    finally { if (request === sequence.current && liveScope.current === scope) setLoading(false); }
  };

  useEffect(() => {
    setSkills([]);
    setSelectedId('');
    setPage(1);
    setDetail(undefined);
    setCanManageTeam(false);
    setLocalDiscoverEnabled(false);
    setOpen(null);
    setEditing(false);
    setRevisions(undefined);
    void refresh();
  }, [scope]);

  const startEdit = (item: TeamSkillItem | 'new') => {
    if (item === 'new') {
      setOpen('new');
      setRevisions(undefined);
      setEditFiles([]);
      form.setFieldsValue({
        name: '',
        title: '',
        description: '',
        scopes: scopeFilter ? [scopeFilter as SkillScopeId] : [],
        visibility: defaultVisibility,
        content: '',
      });
    } else {
      setOpen(item);
      setEditFiles(item.files || []);
      form.setFieldsValue({
        name: item.name,
        title: item.title || item.name,
        description: item.description,
        scopes: item.scopes || [],
        visibility: item.visibility,
        content: item.content || '',
      });
    }
    setEditing(true);
  };

  const loadSingleMdIntoForm = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 80_000) { void message.error('Skill 文件过大，正文不超过 40000 字。'); return; }
    const stem = file.name.replace(/\.(md|markdown|txt)$/i, '');
    const parsed = parseSkillFile(await file.text(), stem === 'SKILL' ? '' : stem);
    const inferred = inferClientScopes(parsed.name, parsed.description);
    form.setFieldsValue({
      content: parsed.content,
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(open === 'new' && parsed.name ? { name: parsed.name, title: form.getFieldValue('title') || parsed.title } : {}),
      ...(inferred.length ? { scopes: inferred } : {}),
    });
  };

  const addRefFilesIntoForm = async (files: FileList | null) => {
    if (!files?.length) return;
    const added: SkillAttachmentFile[] = [];
    for (const file of Array.from(files)) {
      if (file.size > 80_000) { void message.warning(`已跳过过大文件：${file.name}`); continue; }
      const text = await file.text();
      added.push({ path: `references/${file.name}`, content: text });
    }
    if (added.length) {
      setEditFiles(prev => {
        const byPath = new Map(prev.map(f => [f.path, f]));
        for (const f of added) byPath.set(f.path, f);
        return [...byPath.values()];
      });
      void message.success(`已附加 ${added.length} 个参考文件。`);
    }
  };

  const save = async (values: SkillForm) => {
    if (!open || saving) return;
    setSaving(true);
    try {
      const data = open === 'new'
        ? await api<{ skill: TeamSkillItem }>('skills/library', {
            name: values.name.trim(),
            title: values.title.trim(),
            description: values.description.trim(),
            scopes: values.scopes || [],
            visibility: canManageTeam ? values.visibility : 'PERSONAL',
            content: values.content,
            files: editFiles,
            source: 'manual',
          })
        : await api<{ skill: TeamSkillItem }>(`skills/${open.id}`, {
            expectedVersion: open.version,
            title: values.title.trim(),
            description: values.description.trim(),
            scopes: values.scopes || [],
            content: values.content,
            files: editFiles,
          }, 'PATCH');
      if (liveScope.current !== scope) return;
      setSkills(items => items.some(item => item.id === data.skill.id) ? items.map(item => item.id === data.skill.id ? data.skill : item) : [data.skill, ...items]);
      if (open === 'new') setPage(1);
      setSelectedId(data.skill.id);
      setDetail({ scope, item: data.skill });
      setOpen(null);
      setEditing(false);
      setRevisions(undefined);
      void message.success(open === 'new' ? 'Skill 已添加到库。' : 'Skill 已更新。');
      void refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) void message.warning(error.message);
      else fail(error);
    } finally { setSaving(false); }
  };

  const toggle = async (item: TeamSkillItem, enabled: boolean) => {
    try {
      await api(`skills/${item.id}`, { expectedVersion: item.version, enabled }, 'PATCH');
      void refresh();
    } catch (error) { fail(error); }
  };

  const remove = async (item: TeamSkillItem) => {
    try {
      await api(`skills/${item.id}`, undefined, 'DELETE');
      if (liveScope.current !== scope) return;
      setSkills(items => items.filter(skill => skill.id !== item.id));
      void message.success('Skill 已删除。');
      void refresh();
    } catch (error) { fail(error); }
  };

  const openImportModal = (title: string, candidates: ImportCandidate[]) => {
    if (!candidates.length) {
      void message.info('没有找到可导入的 Skill。');
      return;
    }
    setImportTitle(title);
    setImportCandidates(candidates);
    setImportVisibility(defaultVisibility);
    setImportMode('overwrite');
    setImportOpen(true);
  };

  const handleZipUpload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { void message.error('压缩包不能超过 8MB。'); return; }
    setPreparingImport(true);
    try {
      const zipBase64 = await fileToBase64(file);
      const res = await api<{
        skills: { name: string; description: string; content: string; scopes: SkillScopeId[]; files: SkillAttachmentFile[] }[];
      }>('skills/parse-zip', { library: true, filename: file.name, zipBase64 });
      openImportModal(`从压缩包导入（${file.name}）`, res.skills.map((s, idx) => ({
        key: `zip:${idx}:${s.name}`,
        name: s.name,
        description: s.description,
        content: s.content,
        scopes: s.scopes || [],
        files: s.files || [],
        source: 'zip',
        sourceLabel: file.name,
        selected: true,
      })));
    } catch (error) { fail(error); }
    finally { setPreparingImport(false); }
  };

  const handleFolderUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setPreparingImport(true);
    try {
      const files = Array.from(fileList);
      const textFiles: { rel: string; content: string }[] = [];
      for (const file of files) {
        const rel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/');
        if (/(?:^|\/)(?:\.git|node_modules|__MACOSX|\.DS_Store)(?:\/|$)/.test(rel)) continue;
        if (!/\.(md|markdown|txt|ya?ml|json|py|mjs|js|ts|sh)$/i.test(rel)) continue;
        if (file.size > 80_000) continue;
        textFiles.push({ rel, content: await file.text() });
      }
      const skillMds = textFiles.filter(f => /(?:^|\/)SKILL\.md$/i.test(f.rel));
      const candidates: ImportCandidate[] = [];
      if (skillMds.length > 0) {
        for (const [idx, entry] of skillMds.entries()) {
          const dir = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '';
          const folderName = dir ? dir.split('/').pop() || '' : '';
          const parsed = parseSkillFile(entry.content, folderName);
          const prefix = dir ? `${dir}/` : '';
          const attachments = textFiles
            .filter(other => other.rel !== entry.rel && (!prefix || other.rel.startsWith(prefix)) && !/(?:^|\/)SKILL\.md$/i.test(prefix ? other.rel.slice(prefix.length) : other.rel))
            .map(other => ({ path: prefix ? other.rel.slice(prefix.length) : other.rel, content: other.content }))
            .slice(0, 20);
          candidates.push({
            key: `dir:${idx}:${parsed.name}`,
            name: parsed.name,
            title: parsed.title,
            description: parsed.description,
            content: parsed.content,
            scopes: inferClientScopes(parsed.name, parsed.description),
            files: attachments,
            source: 'file',
            sourceLabel: dir || folderName || '本地目录',
            selected: true,
          });
        }
      } else {
        const mds = textFiles.filter(f => /\.(md|markdown)$/i.test(f.rel));
        for (const [idx, entry] of mds.entries()) {
          const stem = entry.rel.split('/').pop()?.replace(/\.(md|markdown)$/i, '') || `skill-${idx + 1}`;
          const parsed = parseSkillFile(entry.content, stem);
          candidates.push({
            key: `dirmd:${idx}:${parsed.name}`,
            name: parsed.name,
            title: parsed.title,
            description: parsed.description,
            content: parsed.content,
            scopes: inferClientScopes(parsed.name, parsed.description),
            files: [],
            source: 'file',
            sourceLabel: entry.rel,
            selected: true,
          });
        }
      }
      openImportModal('从本地文件夹导入 Skills', candidates);
    } catch (error) { fail(error); }
    finally { setPreparingImport(false); }
  };

  const handleMdOrJsonUpload = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setPreparingImport(true);
    try {
      const candidates: ImportCandidate[] = [];
      for (const [idx, file] of Array.from(fileList).entries()) {
        if (file.name.toLowerCase().endsWith('.json')) {
          let raw: unknown;
          try { raw = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} 不是合法的 JSON 配置文件。`); }
          const list = Array.isArray(raw) ? raw : Array.isArray((raw as { skills?: unknown })?.skills) ? (raw as { skills: unknown[] }).skills : null;
          if (!list?.length) throw new Error(`${file.name} 中未找到 skills 配置数组。`);
          for (const [j, item] of list.entries()) {
            const obj = item as Partial<TeamSkillItem>;
            if (!obj?.name || !obj?.content) continue;
            candidates.push({
              key: `json:${idx}:${j}:${obj.name}`,
              name: obj.name,
              title: typeof obj.title === 'string' ? obj.title : undefined,
              description: obj.description || obj.name,
              content: obj.content,
              scopes: Array.isArray(obj.scopes) ? obj.scopes : inferClientScopes(obj.name, obj.description || ''),
              files: Array.isArray(obj.files) ? obj.files : [],
              source: 'json',
              sourceLabel: file.name,
              selected: true,
            });
          }
        } else {
          if (file.size > 80_000) { void message.warning(`跳过过大文件：${file.name}`); continue; }
          const stem = file.name.replace(/\.(md|markdown|txt)$/i, '');
          const parsed = parseSkillFile(await file.text(), stem === 'SKILL' ? '' : stem);
          candidates.push({
            key: `md:${idx}:${parsed.name}`,
            name: parsed.name,
            title: parsed.title,
            description: parsed.description,
            content: parsed.content,
            scopes: inferClientScopes(parsed.name, parsed.description),
            files: [],
            source: 'file',
            sourceLabel: file.name,
            selected: true,
          });
        }
      }
      openImportModal('从文件 / JSON 配置导入 Skills', candidates);
    } catch (error) { fail(error); }
    finally { setPreparingImport(false); }
  };

  const openLocalDiscover = async () => {
    setPreparingImport(true);
    try {
      const res = await api<{
        skills: { name: string; description: string; content: string; scopes: SkillScopeId[]; files: SkillAttachmentFile[]; sourceLabel: string }[];
      }>('skills/local-discover?library=1');
      const existingNames = libraryNames(defaultVisibility);
      openImportModal('扫描并导入本机已安装的 Skills', res.skills.map((s, idx) => ({
        key: `local:${idx}:${s.name}`,
        name: s.name,
        description: s.description,
        content: s.content,
        scopes: s.scopes || [],
        files: s.files || [],
        source: 'local',
        sourceLabel: s.sourceLabel,
        selected: !existingNames.has(s.name),
      })));
    } catch (error) { fail(error); }
    finally { setPreparingImport(false); }
  };

  const openPresetLibrary = async () => {
    setPreparingImport(true);
    try {
      const existingNames = libraryNames(defaultVisibility);
      const res = await api<{ presets: { name: string; description: string; content: string; scopes: SkillScopeId[] }[] }>('skills/presets');
      openImportModal('推荐场景 Skill 套件（覆盖评审 / 技术方案 / 代码 / Jira）', res.presets.map((p, idx) => ({
        key: `preset:${idx}:${p.name}`,
        name: p.name,
        description: p.description,
        content: p.content,
        scopes: p.scopes,
        files: [],
        source: 'preset',
        sourceLabel: '官方推荐模板',
        selected: !existingNames.has(p.name),
      })));
    } catch (error) { fail(error); }
    finally { setPreparingImport(false); }
  };

  const confirmBatchImport = async () => {
    const picked = importCandidates.filter(c => c.selected);
    if (!picked.length) return;
    setImporting(true);
    try {
      const res = await api<{ imported: string[]; updated: string[]; skipped: string[] }>('skills/library/import', {
        visibility: canManageTeam ? importVisibility : 'PERSONAL',
        mode: importMode,
        items: picked.map(item => ({
          name: item.name,
          title: item.title,
          description: item.description,
          content: item.content,
          scopes: item.scopes,
          files: item.files,
          source: item.source,
        })),
      });
      const parts = [
        res.imported.length ? `新增 ${res.imported.length}` : '',
        res.updated.length ? `更新 ${res.updated.length}` : '',
        res.skipped.length ? `跳过 ${res.skipped.length}` : '',
      ].filter(Boolean);
      void message.success(`Skill 导入完成：${parts.join('，') || '无变更'}。`);
      setImportOpen(false);
      void refresh();
    } catch (error) { fail(error); }
    finally { setImporting(false); }
  };

  const exportAllConfig = async () => {
    try {
      const data = await api<Record<string, unknown>>('skills/library/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'taskflow-skills.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      void message.success('已导出 Skills 配置文件（JSON）。');
    } catch (error) { fail(error); }
  };

  const visibleSkills = (loadedScope === scope ? skills : []).filter(item => {
    if (scopeFilter && item.scopes.length > 0 && !item.scopes.includes(scopeFilter as SkillScopeId)) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      if (!`${item.title || ''} ${item.name} ${item.description}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const activePage = Math.min(page, Math.max(1, Math.ceil(visibleSkills.length / SKILL_PAGE_SIZE)));
  const pageStart = (activePage - 1) * SKILL_PAGE_SIZE;
  const pageSkills = visibleSkills.slice(pageStart, pageStart + SKILL_PAGE_SIZE);
  const selected = pageSkills.find(item => item.id === selectedId) || pageSkills[0];
  const selectedKey = JSON.stringify([scope, selected?.id, selected?.version]);
  const current = selected && detail?.scope === scope && detail.item.id === selected.id && detail.item.version >= selected.version ? detail.item : selected;
  const currentFile = current?.files?.find(file => file.path === filePath) || current?.files?.[0];
  const currentRevisions = revisions?.key === selectedKey ? revisions.items : undefined;
  const currentRevision = currentRevisions?.find(item => item.version === revisionVersion) || currentRevisions?.[0];
  useEffect(() => {
    setFilePath('');
    setRevisionVersion(undefined);
    setFailedDetailKey('');
    if (!selected) return;
    let cancelled = false;
    const path = `skills/${encodeURIComponent(selected.id)}`;
    const isCurrent = () => !cancelled && liveScope.current === scope;
    void api<{ skill: TeamSkillItem }>(path).then(data => {
      if (isCurrent()) setDetail({ scope, item: data.skill });
    }).catch(error => {
      if (!isCurrent()) return;
      setFailedDetailKey(selectedKey);
      fail(error);
    });
    if (selected.visibility === 'TEAM' && selected.version > 1) {
      void api<{ revisions: Revision[] }>(`${path}/revisions`).then(data => {
        if (isCurrent()) setRevisions({ key: selectedKey, items: data.revisions });
      }).catch(error => { if (isCurrent()) fail(error); });
    }
    return () => { cancelled = true; };
  }, [selectedKey, detailAttempt]);

  const importMenuItems: MenuProps['items'] = [
    { key: 'zip', icon: <FileArchive size={14} />, label: '上传 .zip 技能包（支持含 references 参考文档）', onClick: () => zipInput.current?.click() },
    { key: 'folder', icon: <FolderUp size={14} />, label: '上传本地 Skill 文件夹', onClick: () => folderInput.current?.click() },
    { key: 'file', icon: <FileUp size={14} />, label: '上传 SKILL.md 或 JSON 配置包', onClick: () => multiMdJsonInput.current?.click() },
    ...(localDiscoverEnabled ? [{ key: 'local', icon: <ScanSearch size={14} />, label: '扫描本机已安装的 Skills（Codex / Claude / Cursor）', onClick: () => void openLocalDiscover() }] : []),
    { type: 'divider' },
    { key: 'presets', icon: <Sparkles size={14} />, label: '导入推荐套件（需求/Jira/方案/代码/测试/上线）', onClick: () => void openPresetLibrary() },
  ];

  const columns: TableColumnsType<TeamSkillItem> = [
    {
      title: 'Skills',
      render: (_, item) => (
        <Flex vertical gap={4} className="tf-skill-row">
          <button type="button" className="tf-skill-select" aria-pressed={selected?.id === item.id} onClick={() => setSelectedId(item.id)}>{item.title || item.name}</button>
          <Typography.Text type="secondary" className="tf-skill-description">{item.description}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {item.visibility === 'TEAM' ? '团队' : '个人'} · {item.scopes.length ? item.scopes.map(scopeLabel).join('、') : '全部场景'}
            {item.fileCount > 0 ? ` · ${item.fileCount} 个文件` : ''}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: '启用',
      width: 75,
      render: (_, item) => item.canManage
        ? <Switch size="small" aria-label={`启用 ${item.title || item.name}`} checked={item.enabled} onChange={value => void toggle(item, value)} />
        : <Typography.Text type="secondary">{item.enabled ? '启用' : '停用'}</Typography.Text>,
    },
  ];

  const selectedImportCount = importCandidates.filter(c => c.selected).length;
  const existingImportNames = importOpen ? libraryNames(importVisibility) : undefined;

  return (
    <Flex vertical gap={14} className="tf-skills-workspace">
      <Flex gap={8} justify="space-between" align="center" wrap className="tf-skills-toolbar">
        <Space size={8} wrap>
          <Input.Search
            aria-label="搜索 Skills"
            allowClear
            placeholder="搜索标题、标识或用途"
            className="tf-skills-search"
            value={query}
            onChange={event => { setQuery(event.target.value); setPage(1); }}
          />
          <Select
            aria-label="按场景筛选"
            allowClear
            placeholder="全部场景"
            className="tf-skills-scope"
            value={scopeFilter || undefined}
            onChange={v => { setScopeFilter(v || ''); setPage(1); }}
            options={scopeCatalog.map(sc => ({ value: sc.id, label: sc.label }))}
          />
        </Space>
        <Space size={8} wrap>
          <Button icon={<RefreshCw size={14} />} loading={loading} onClick={() => { void refresh(); setDetailAttempt(value => value + 1); }}>刷新</Button>
          {skills.length > 0 && (
            <Button icon={<Download size={14} />} onClick={() => void exportAllConfig()}>导出 Skills</Button>
          )}
          <Dropdown disabled={preparingImport} menu={{ items: importMenuItems }}>
            <Button icon={<FileUp size={14} />} loading={preparingImport}>导入 Skills</Button>
          </Dropdown>
          <Button type="primary" icon={<Plus size={14} />} onClick={() => startEdit('new')}>
            添加 Skill
          </Button>
        </Space>
      </Flex>

      <div className="tf-reading-layout tf-skills-reading">
        <Table<TeamSkillItem>
          rowKey="id"
          size="small"
          rowClassName={item => item.id === selected?.id ? 'tf-skill-selected' : ''}
          loading={loading}
          dataSource={visibleSkills}
          columns={columns}
          pagination={{ current: activePage, pageSize: SKILL_PAGE_SIZE, onChange: setPage, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty description={query || scopeFilter ? '没有匹配的 Skill。' : 'Skills 库暂无内容。'}>
                {!query && !scopeFilter && (
                  <Space wrap style={{ marginTop: 8 }}>
                    <Button type="primary" icon={<FileArchive size={14} />} onClick={() => zipInput.current?.click()}>上传 .zip 技能包</Button>
                    <Button icon={<Sparkles size={14} />} onClick={() => void openPresetLibrary()}>导入推荐套件</Button>
                    {localDiscoverEnabled && (
                      <Button icon={<ScanSearch size={14} />} onClick={() => void openLocalDiscover()}>扫描本机 Skills</Button>
                    )}
                  </Space>
                )}
              </Empty>
            ),
          }}
        />

        {current ? (
          <Card
            size="small"
            className="tf-skill-detail"
            title={current.title || current.name}
            extra={<Space size={8} wrap>
              {current.canManage && <Button size="small" icon={<Pencil size={14} />} disabled={current.content === undefined} onClick={() => startEdit(current)}>编辑</Button>}
              {current.canManage && <Popconfirm title="确定删除这个 Skill？" description="已关联的项目也会停止使用。" okText="删除" cancelText="取消" onConfirm={() => void remove(current)}>
                <Button size="small" danger icon={<Trash2 size={14} />} aria-label="删除 Skill" />
              </Popconfirm>}
            </Space>}
          >
            <Flex vertical gap={14}>
              <Typography.Paragraph style={{ marginBottom: 0 }}>{current.description}</Typography.Paragraph>
              <Space size={[6, 6]} wrap>
                <Typography.Text code>{current.name}</Typography.Text>
                <Typography.Text type="secondary">{current.visibility === 'TEAM' ? '团队共享' : '个人'} · {current.enabled ? '已启用' : '已停用'} · v{current.version}</Typography.Text>
                {current.scopes.map(item => <Tag key={item} color={SCOPE_COLORS[item]}>{scopeLabel(item)}</Tag>)}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{current.updatedByName} · {when(current.updatedAt)}</Typography.Text>
              </Space>

              {current.content !== undefined
                ? <MarkdownPreview content={current.content} />
                : failedDetailKey !== selectedKey && <Skeleton active paragraph={{ rows: 4 }} />}

              {currentFile && (
                <section aria-labelledby="skill-files-heading" className="tf-skill-section">
                  <Flex gap={8} align="center" wrap>
                    <Typography.Text strong id="skill-files-heading">参考文件</Typography.Text>
                    <Select
                      size="small"
                      aria-label="参考文件"
                      value={currentFile.path}
                      options={current.files?.map(file => ({ value: file.path, label: file.path }))}
                      onChange={setFilePath}
                    />
                  </Flex>
                  {/\.md$/i.test(currentFile.path) ? <MarkdownPreview content={currentFile.content} /> : <pre className="tf-code-panel">{currentFile.content}</pre>}
                </section>
              )}

              {currentRevisions && (
                <section aria-labelledby="skill-history-heading" className="tf-skill-section">
                  <Flex gap={8} align="center" wrap>
                    <Typography.Text strong id="skill-history-heading">历史版本</Typography.Text>
                    {currentRevision && <Select size="small" aria-label="历史版本" value={currentRevision.version}
                      options={currentRevisions.map(item => ({ value: item.version, label: `v${item.version} · ${item.editedBy} · ${when(item.editedAt)}${item.enabled ? '' : ' · 停用'}` }))}
                      onChange={setRevisionVersion}
                    />}
                  </Flex>
                  {currentRevision ? <MarkdownPreview content={currentRevision.content} /> : <Typography.Text type="secondary">暂无历史版本。</Typography.Text>}
                </section>
              )}
            </Flex>
          </Card>
        ) : null}
      </div>

      {/* Hidden file inputs */}
      <input ref={singleFileInput} type="file" hidden accept=".md,.markdown,.txt" onChange={e => { void loadSingleMdIntoForm(e.target.files); e.target.value = ''; }} />
      <input ref={refFileInput} type="file" hidden multiple accept=".md,.markdown,.txt,.yaml,.yml,.json,.py,.js,.ts,.sh" onChange={e => { void addRefFilesIntoForm(e.target.files); e.target.value = ''; }} />
      <input ref={zipInput} type="file" hidden accept=".zip,application/zip" onChange={e => { void handleZipUpload(e.target.files); e.target.value = ''; }} />
      <input
        ref={folderInput}
        type="file"
        hidden
        multiple
        {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
        onChange={e => { void handleFolderUpload(e.target.files); e.target.value = ''; }}
      />
      <input ref={multiMdJsonInput} type="file" hidden multiple accept=".md,.markdown,.txt,.json,application/json" onChange={e => { void handleMdOrJsonUpload(e.target.files); e.target.value = ''; }} />

      <Drawer
        open={editing && !!open}
        size={800}
        onClose={() => { if (!saving) { setOpen(null); setEditing(false); } }}
        closable={!saving}
        keyboard={!saving}
        maskClosable={!saving}
        destroyOnHidden
        title={open === 'new' ? '添加 Skill' : open ? `编辑 ${open.title || open.name}` : undefined}
        extra={<Space>
          <Button icon={<FileUp size={14} />} disabled={saving} onClick={() => singleFileInput.current?.click()}>读取 SKILL.md</Button>
          <Button disabled={saving} onClick={() => { setOpen(null); setEditing(false); }}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => form.submit()}>保存</Button>
        </Space>}
      >
        <Form<SkillForm> form={form} layout="vertical" disabled={saving} onFinish={values => void save(values)}>
          <Form.Item
            name="title"
            label="显示标题"
            rules={[{ required: true, whitespace: true, message: '请填写标题' }, { max: 120, message: '标题不能超过 120 字' }]}
          >
            <Input maxLength={120} placeholder="例如 前端代码评审" />
          </Form.Item>
          <Flex gap={12} wrap>
            <Form.Item
              name="name"
              label="Skill 标识"
              style={{ flex: '1 1 240px' }}
              extra="用于调用，创建后固定。"
              rules={[
                { required: true, message: '请填写名称' },
                { pattern: /^[a-z0-9][a-z0-9-]{0,62}$/, message: '只能用小写字母、数字和连字符，且不以连字符开头' },
              ]}
            >
              <Input placeholder="例如 frontend-code-review" disabled={open !== 'new'} />
            </Form.Item>
            <Form.Item
              name="visibility"
              label="可见范围"
              style={{ flex: '0 0 220px' }}
              extra="在项目空间关联后按场景生效。"
            >
              <Radio.Group disabled={open !== 'new' || !canManageTeam} optionType="button" buttonStyle="solid">
                <Radio value="TEAM" disabled={!canManageTeam}>团队共享</Radio>
                <Radio value="PERSONAL">仅自己</Radio>
              </Radio.Group>
            </Form.Item>
          </Flex>

          <Form.Item
            name="scopes"
            label="适用场景（可多选；留空表示所有 AI 场景都生效）"
          >
            <Select
              mode="multiple"
              allowClear
              placeholder="选择此 Skill 在哪些环节自动生效（例如：代码评审、技术方案生成、Jira 拆解）"
              options={scopeCatalog.map(sc => ({ value: sc.id, label: `${sc.label} — ${sc.description}` }))}
            />
          </Form.Item>

          <Form.Item
            name="description"
            label="简短说明"
            rules={[
              { required: true, whitespace: true, message: '请填写说明' },
              { max: 500 },
              { pattern: /^[^\r\n]*$/, message: '说明不能换行' },
            ]}
          >
            <Input placeholder="写清这个 Skill 解决什么问题、何时使用" />
          </Form.Item>

          <Form.Item
            name="content"
            label="SKILL.md 规则正文"
            rules={[
              { required: true, whitespace: true, message: '请填写正文' },
              { max: 40_000, message: '正文不超过 40000 字' },
            ]}
          >
            <Input.TextArea
              autoSize={{ minRows: 14, maxRows: 28 }}
              style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 12.5 }}
              placeholder={'# 前端代码评审\n\n## 审查重点\n- 检查组件职责边界与重复实现\n- 核查安全与性能门禁'}
            />
          </Form.Item>

          <Flex vertical gap={8} style={{ borderTop: '1px solid var(--tf-divider)', paddingTop: 12 }}>
            <Flex justify="space-between" align="center">
              <Typography.Text strong style={{ fontSize: 13 }}>附属参考文件（{editFiles.length}）</Typography.Text>
              <Button size="small" icon={<Plus size={13} />} onClick={() => refFileInput.current?.click()}>附加参考文档</Button>
            </Flex>
            {editFiles.length > 0 ? (
              <Space size={[6, 6]} wrap>
                {editFiles.map(f => (
                  <Tag
                    key={f.path}
                    closable
                    onClose={() => setEditFiles(prev => prev.filter(item => item.path !== f.path))}
                  >
                    {f.path}
                  </Tag>
                ))}
              </Space>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                可选：如 references/quality-rules.md、scripts/ 等配套文件，AI 执行时会自动展开到运行目录供直接读取。
              </Typography.Text>
            )}
          </Flex>
        </Form>
      </Drawer>

      {/* Unified Import Preview Modal */}
      <Modal
        open={importOpen}
        width={760}
        title={importTitle}
        onCancel={() => setImportOpen(false)}
        okText={`确认导入 (${selectedImportCount} 项)`}
        cancelText="取消"
        okButtonProps={{ disabled: !selectedImportCount, loading: importing }}
        onOk={() => void confirmBatchImport()}
      >
        <Flex vertical gap={12}>
          <Flex justify="space-between" align="center" gap={12} wrap>
            <Space size={10} wrap>
              <Typography.Text style={{ fontSize: 12.5 }}>导入为：</Typography.Text>
              <Radio.Group
                size="small"
                value={canManageTeam ? importVisibility : 'PERSONAL'}
                onChange={e => setImportVisibility(e.target.value)}
                optionType="button"
              >
                <Radio value="TEAM" disabled={!canManageTeam}>团队共享</Radio>
                <Radio value="PERSONAL">仅自己</Radio>
              </Radio.Group>
            </Space>
            <Space size={8} wrap>
              <Typography.Text style={{ fontSize: 12.5 }}>同名处理：</Typography.Text>
              <Radio.Group size="small" value={importMode} onChange={e => setImportMode(e.target.value)}>
                <Radio value="overwrite">覆盖更新</Radio>
                <Radio value="skip">跳过同名</Radio>
              </Radio.Group>
            </Space>
          </Flex>

          <Flex vertical gap={8} style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
            {importCandidates.map(item => (
              <div
                key={item.key}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--tf-border)',
                  background: item.selected ? 'var(--tf-surface)' : 'var(--tf-raised)',
                  opacity: item.selected ? 1 : 0.65,
                }}
              >
                <Flex justify="space-between" align="start" gap={10}>
                  <Checkbox
                    checked={item.selected}
                    onChange={e => setImportCandidates(prev => prev.map(c => c.key === item.key ? { ...c, selected: e.target.checked } : c))}
                  >
                    <Space size={6} wrap>
                      <Typography.Text strong>{item.title || item.name}</Typography.Text>
                      {item.files.length > 0 && <Tag style={{ marginInlineEnd: 0 }}>含 {item.files.length} 个参考文件</Tag>}
                      {existingImportNames?.has(item.name) && <Tag color="warning" style={{ marginInlineEnd: 0 }}>已存在</Tag>}
                      {item.sourceLabel && <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>{item.sourceLabel}</Typography.Text>}
                    </Space>
                  </Checkbox>
                </Flex>
                <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: '4px 0 8px 24px', fontSize: 12 }}>
                  {item.description}
                </Typography.Paragraph>
                <div style={{ marginLeft: 24 }}>
                  <Select
                    size="small"
                    mode="multiple"
                    allowClear
                    style={{ width: '100%' }}
                    placeholder="适用场景（留空=全部场景生效）"
                    value={item.scopes}
                    options={scopeCatalog.map(sc => ({ value: sc.id, label: sc.label }))}
                    onChange={nextScopes => setImportCandidates(prev => prev.map(c => c.key === item.key ? { ...c, scopes: nextScopes } : c))}
                  />
                </div>
              </div>
            ))}
          </Flex>
        </Flex>
      </Modal>
    </Flex>
  );
};
