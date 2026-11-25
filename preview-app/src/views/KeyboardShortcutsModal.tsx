import React from 'react';
import { Flex, Modal, Space, Tag, Typography } from 'antd';
import { Keyboard } from 'lucide-react';

const SHORTCUT_GROUPS: { title: string; items: { keys: string[]; desc: string }[] }[] = [
  {
    title: '全局导航',
    items: [
      { keys: ['⌘ / Ctrl', 'K'], desc: '打开全局快捷跳转面板（搜索任务、切换项目、快捷动作）' },
      { keys: ['?'], desc: '打开 / 关闭键盘快捷键指南（亦可按 ⌘ / Ctrl + /）' },
    ],
  },
  {
    title: '任务列表与看板',
    items: [
      { keys: ['/'], desc: '聚焦任务搜索框' },
      { keys: ['Esc'], desc: '清空当前搜索词或关闭浮层' },
      { keys: ['V'], desc: '在「列表视图」与「状态看板」之间一键切换' },
    ],
  },
  {
    title: '任务详情与评审处理',
    items: [
      { keys: ['['], desc: '切换到当前筛选列表中的上一项任务' },
      { keys: [']'], desc: '切换到当前筛选列表中的下一项任务' },
      { keys: ['I'], desc: '在完整任务详情页认领当前任务' },
      { keys: ['⌘ / Ctrl', 'Enter'], desc: '快速提交进度记录、材料正文、评审报告或门禁审批' },
    ],
  },
];

export const KeyboardShortcutsModal: React.FC<{
  open: boolean;
  onClose: () => void;
}> = ({ open, onClose }) => (
  <Modal
    open={open}
    onCancel={onClose}
    footer={null}
    width={540}
    title={<Space size={8}><Keyboard size={17} /><span>键盘快捷键指南</span></Space>}
  >
    <Flex vertical gap={14} style={{ paddingTop: 4 }}>
      {SHORTCUT_GROUPS.map(group => (
        <div key={group.title}>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            {group.title}
          </Typography.Text>
          <Flex vertical gap={6}>
            {group.items.map(item => (
              <Flex
                key={item.desc}
                justify="space-between"
                align="center"
                gap={12}
                style={{ padding: '6px 10px', background: 'var(--tf-raised)', border: '1px solid var(--tf-border)', borderRadius: 8 }}
              >
                <Typography.Text style={{ fontSize: 13 }}>{item.desc}</Typography.Text>
                <Space size={4} style={{ flexShrink: 0 }}>
                  {item.keys.map(k => (
                    <Tag key={k} style={{ marginInlineEnd: 0, fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>
                      {k}
                    </Tag>
                  ))}
                </Space>
              </Flex>
            ))}
          </Flex>
        </div>
      ))}
    </Flex>
  </Modal>
);
