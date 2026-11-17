import React, { useState } from 'react';
import { Button, Popover } from 'antd';
import { Check, Palette } from 'lucide-react';
import { resolveTaskFlowTheme, TASKFLOW_THEMES, type TaskFlowThemeId } from './theme';

export const ThemePicker: React.FC<{
  value: TaskFlowThemeId;
  onChange: (next: TaskFlowThemeId) => void;
}> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const active = resolveTaskFlowTheme(value);

  const panel = (
    <div className="tf-theme-popover" role="listbox" aria-label="选择工作台主题风格">
      <div className="tf-theme-popover-head">
        <span>设计系统与空间架构</span>
        <small>awesome-design-md</small>
      </div>
      <div className="tf-theme-grid">
        {TASKFLOW_THEMES.map(item => {
          const selected = item.id === value;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={selected}
              className={`tf-theme-option${selected ? ' is-active' : ''}`}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
              }}
            >
              <span className="tf-theme-swatch" aria-hidden="true">
                <i style={{ background: item.swatch[0] }} />
                <i style={{ background: item.swatch[1] }} />
                <i style={{ background: item.swatch[2] }} />
              </span>
              <span className="tf-theme-copy">
                <span className="tf-theme-title-row">
                  <strong>{item.label}</strong>
                  <em className="tf-theme-badge">{item.badge}</em>
                </span>
                <small>{item.subtitle}</small>
              </span>
              {selected && <Check size={14} className="tf-theme-check" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <Popover
      content={panel}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      open={open}
      onOpenChange={setOpen}
      classNames={{ root: 'tf-theme-popper' }}
    >
      <Button size="small" className="tf-theme-trigger" aria-label="切换主题风格">
        <Palette size={14} />
        <span>{active.label}</span>
      </Button>
    </Popover>
  );
};
