import { Collapse, Descriptions, Flex, Tag, Typography } from 'antd';
import { LinkifiedText, MarkdownPreview } from './MarkdownPreview';
import { buildCodeMaterialPreview, type NodeTestSummary } from './codeMaterialContent';

function TestSummary({ counts }: { counts: NodeTestSummary }) {
  return <Flex gap={6} align="center" wrap aria-label="测试摘要">
    <Typography.Text strong>共 {counts.tests} 项测试</Typography.Text>
    <Tag color={counts.pass ? 'success' : undefined}>通过 {counts.pass}</Tag>
    <Tag color={counts.fail ? 'error' : undefined}>失败 {counts.fail}</Tag>
    {counts.cancelled > 0 && <Tag color="warning">取消 {counts.cancelled}</Tag>}
    {counts.skipped > 0 && <Tag>跳过 {counts.skipped}</Tag>}
    {counts.todo > 0 && <Tag>待办 {counts.todo}</Tag>}
  </Flex>;
}

export function CodeMaterialPreview({ content }: { content: string }) {
  const { metadata, sections } = buildCodeMaterialPreview(content);
  if (!metadata.length && !sections.length) return <pre className="tf-code-panel">{content}</pre>;

  return <Flex vertical gap={10} className="tf-code-material-preview">
    {metadata.length > 0 && <Descriptions size="small" title="提交信息" column={{ xs: 1, sm: 2 }} items={metadata.map(item => ({
      key: item.label,
      label: item.label,
      children: <code className="tf-break"><LinkifiedText text={item.value} /></code>,
    }))} />}
    {sections.map((section, index) => section.type === 'markdown' ? (
      <MarkdownPreview key={index} content={content} blocks={section.blocks} />
    ) : <Flex vertical key={index} gap={6}>
      {section.type === 'test' && <TestSummary counts={section.counts} />}
      <Collapse size="small" items={[{
        key: 'contents',
        label: section.type === 'diff'
          ? `代码差异${section.files > 0 ? ` · ${section.files} 个文件` : ''} · +${section.additions} / −${section.deletions}`
          : section.type === 'test' ? '查看测试日志' : section.lang ? `查看代码片段 · ${section.lang}` : '查看代码片段',
        children: <pre className="tf-code-panel">{section.code}</pre>,
      }]} />
    </Flex>)}
    <Collapse size="small" items={[{
      key: 'raw',
      label: '查看原始内容',
      children: <pre className="tf-code-panel">{content}</pre>,
    }]} />
  </Flex>;
}
