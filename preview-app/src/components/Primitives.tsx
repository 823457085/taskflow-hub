import React from 'react';
import { Modal as AntModal, Tag, Typography } from 'antd';
import { CheckCircle2, AlertTriangle, XCircle, Clock, Sparkles, CircleDot } from 'lucide-react';

export type BadgeVariant = 'blue' | 'green' | 'neutral' | 'warn' | 'block' | 'violet';

const STATUS_STYLES: Record<BadgeVariant, React.CSSProperties> = {
  blue: {
    color: 'var(--tf-accent)',
    background: 'var(--tf-accent-soft)',
    borderColor: 'color-mix(in srgb, var(--tf-accent) 28%, var(--tf-border))',
  },
  green: {
    color: 'var(--tf-success)',
    background: 'var(--tf-success-bg)',
    borderColor: 'color-mix(in srgb, var(--tf-success) 30%, var(--tf-border))',
  },
  neutral: {
    color: 'var(--tf-secondary)',
    background: 'var(--tf-raised)',
    borderColor: 'var(--tf-border)',
  },
  warn: {
    color: 'var(--tf-warning)',
    background: 'var(--tf-warning-bg)',
    borderColor: 'color-mix(in srgb, var(--tf-warning) 30%, var(--tf-border))',
  },
  block: {
    color: 'var(--tf-error)',
    background: 'var(--tf-error-bg)',
    borderColor: 'color-mix(in srgb, var(--tf-error) 32%, var(--tf-border))',
  },
  violet: {
    color: 'var(--tf-accent)',
    background: 'var(--tf-accent-soft)',
    borderColor: 'color-mix(in srgb, var(--tf-accent) 30%, var(--tf-border))',
  },
};

export const StatusBadge: React.FC<{
  variant?: BadgeVariant;
  children: React.ReactNode;
  pulse?: boolean;
  icon?: React.ReactNode;
}> = ({ variant = 'blue', children, pulse = false, icon }) => {
  const defaultIcon: Record<BadgeVariant, React.ReactNode> = {
    blue: pulse ? <span className="tf-status-pulse" /> : <CircleDot size={12} />,
    green: <CheckCircle2 size={12} />,
    neutral: <Clock size={12} />,
    warn: <AlertTriangle size={12} />,
    block: <XCircle size={12} />,
    violet: <Sparkles size={12} />,
  };
  return (
    <Tag variant="outlined" className={`tf-status-tag tf-status-${variant}`} style={STATUS_STYLES[variant]}>
      <span className="tf-status-icon" aria-hidden="true">{icon ?? defaultIcon[variant]}</span>
      <span>{children}</span>
    </Tag>
  );
};

export const Modal: React.FC<{
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidthClass?: string;
}> = ({ open, title, subtitle, onClose, children, maxWidthClass }) => {
  const width = Number(maxWidthClass?.match(/max-w-\[(\d+)px\]/)?.[1] || 600);
  return (
    <AntModal
      open={open}
      title={
        <div className="tf-modal-heading">
          <Typography.Title level={4}>{title}</Typography.Title>
          {subtitle && <Typography.Paragraph type="secondary">{subtitle}</Typography.Paragraph>}
        </div>
      }
      onCancel={onClose}
      footer={null}
      width={width}
      centered
      destroyOnHidden
      styles={{ body: { maxHeight: 'calc(90vh - 128px)', overflowY: 'auto' } }}
    >
      {children}
    </AntModal>
  );
};
