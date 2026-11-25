import React, { useEffect, useRef, useState } from 'react';
import { App, Button, Dropdown, Space, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import { Check, ChevronDown, Copy, Download, FileCode2, FileText, Globe, Printer } from 'lucide-react';
import {
  downloadReviewDocument,
  formatReviewReportHtml,
  formatReviewReportMarkdown,
  formatReviewReportPlainText,
  printReviewReportHtml,
  reviewExportFilename,
  type ReviewExportInput,
} from './reviewReportExport';

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to legacy execCommand copy below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface ReviewExportActionsProps {
  data: ReviewExportInput;
  size?: 'small' | 'middle';
  extraExportItems?: MenuProps['items'];
}

export const ReviewExportActions: React.FC<ReviewExportActionsProps> = ({
  data,
  size = 'small',
  extraExportItems,
}) => {
  const { message } = App.useApp();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const markCopied = () => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyPlain = async () => {
    const text = formatReviewReportPlainText(data);
    const ok = await copyTextToClipboard(text);
    if (ok) {
      markCopied();
      void message.success('已复制通俗版评审内容，可直接粘贴到群聊或文档。');
    } else {
      void message.warning('浏览器未能自动复制，请检查剪贴板权限。');
    }
  };

  const handleCopyMarkdown = async () => {
    const md = formatReviewReportMarkdown(data);
    const ok = await copyTextToClipboard(md);
    if (ok) {
      markCopied();
      void message.success('已复制 Markdown 格式评审报告。');
    } else {
      void message.warning('浏览器未能自动复制，请检查剪贴板权限。');
    }
  };

  const handleExportWord = () => {
    const filename = reviewExportFilename(data.task, data.stage, 'doc');
    const html = formatReviewReportHtml(data, { forWord: true });
    downloadReviewDocument(html, filename, 'application/msword;charset=utf-8', true);
    void message.success(`已导出 Word 文档：${filename}`);
  };

  const handleExportHtml = () => {
    const filename = reviewExportFilename(data.task, data.stage, 'html');
    const html = formatReviewReportHtml(data, { forWord: false });
    downloadReviewDocument(html, filename, 'text/html;charset=utf-8', false);
    void message.success(`已导出网页报告：${filename}`);
  };

  const handleExportMarkdown = () => {
    const filename = reviewExportFilename(data.task, data.stage, 'md');
    const md = formatReviewReportMarkdown(data);
    downloadReviewDocument(md, filename, 'text/markdown;charset=utf-8', false);
    void message.success(`已导出 Markdown 文档：${filename}`);
  };

  const handlePrintPdf = () => {
    const html = formatReviewReportHtml(data, { forWord: false });
    const started = printReviewReportHtml(html);
    if (!started) {
      handleExportHtml();
    }
  };

  const menuItems: MenuProps['items'] = [
    {
      key: 'word',
      icon: <FileText size={14} />,
      label: '导出 Word 文档 (.doc)',
      onClick: handleExportWord,
    },
    {
      key: 'html',
      icon: <Globe size={14} />,
      label: '导出网页报告 (.html)',
      onClick: handleExportHtml,
    },
    {
      key: 'markdown',
      icon: <FileCode2 size={14} />,
      label: '导出 Markdown (.md)',
      onClick: handleExportMarkdown,
    },
    {
      key: 'print',
      icon: <Printer size={14} />,
      label: '打印 / 另存为 PDF',
      onClick: handlePrintPdf,
    },
    { type: 'divider' },
    {
      key: 'copy-plain',
      icon: <Copy size={14} />,
      label: '复制通俗文本（适合群聊 / 邮件）',
      onClick: () => void handleCopyPlain(),
    },
    {
      key: 'copy-md',
      icon: <FileCode2 size={14} />,
      label: '复制 Markdown（适合文档 / 语雀）',
      onClick: () => void handleCopyMarkdown(),
    },
    ...(extraExportItems?.length ? [{ type: 'divider' as const }, ...extraExportItems] : []),
  ];

  return (
    <Space size={6} wrap className="tf-review-export-actions">
      <Tooltip title="一键复制通俗易懂的评审内容，可直接粘贴到企微 / 飞书 / 邮件">
        <Button
          size={size}
          icon={copied ? <Check size={13} /> : <Copy size={13} />}
          onClick={() => void handleCopyPlain()}
        >
          {copied ? '已复制' : '复制内容'}
        </Button>
      </Tooltip>
      <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
        <Button size={size} icon={<Download size={13} />}>
          导出文档 <ChevronDown size={12} style={{ marginInlineStart: 2, verticalAlign: '-2px' }} />
        </Button>
      </Dropdown>
    </Space>
  );
};
