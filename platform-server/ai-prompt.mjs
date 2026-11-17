export function buildAiPrompt({ mode, task, job, repoPath, constitutionFiles = [], contextFilePath, customInstruction }) {
  const header = [
    `你正在协助处理 TaskFlow 研发任务 ${task.jiraKey}（${task.title}）。`,
    `已验证的任务上下文与材料快照保存在当前运行目录文件：${contextFilePath}（也可使用已配置的 taskflow MCP 工具核对）。`,
  ];
  if (Array.isArray(constitutionFiles) && constitutionFiles.length > 0) {
    header.push(`已识别到业务仓库工程规范文件：${constitutionFiles.join('、')}，请在分析、实现与评审时严格遵循仓库内的架构、契约与测试规范。`);
  }
  if (customInstruction) header.push(`用户补充说明：${customInstruction}`);
  if (mode === 'read') {
    return [
      ...header,
      '请直接读取上下文快照，输出清晰简洁的中文结论：',
      '1. 当前任务核心目标与关键业务改动点',
      '2. 现有材料完备度与缺失项（对照 PRD → TECH_SPEC → CODE → TEST_CASE → RELEASE_PLAN）',
      '3. 建议的下一步具体执行动作',
      '约束：只做分析，不要修改任何代码文件、不要提交报告或更改外部系统。',
    ].join('\n\n');
  }
  if (mode === 'develop') {
    return [
      ...header,
      `当前工作目录即为已绑定的业务代码仓库：${repoPath}。`,
      '请结合任务需求与材料直接推进代码实现与本地自测验证，完成后用中文总结修改的文件、核心逻辑与验证结果。',
      '约束：严禁执行 git push、严禁修改外部 Jira/Confluence/GitLab、严禁修改不相关的其他项目。',
    ].join('\n\n');
  }
  const snapshotPlugins = Array.isArray(job?.snapshot?.plugins) ? job.snapshot.plugins : [];
  const policyLine = snapshotPlugins.length > 0
    ? `本项目已启用阶段门禁策略插件（策略指纹: ${job?.snapshot?.policyHash ? String(job.snapshot.policyHash).slice(0, 12) : 'frozen'}）：${snapshotPlugins.map(p => `${p.name} [${p.id}@${p.version}]`).join('、')}。请逐项核验冻结材料是否满足上述策略门禁，并在评审结论或 findings 中体现核查结果。`
    : '';
  return [
    ...header,
    `本次为阶段【${job.stage}】的本地工具评审（Job ID: ${job.id}，冻结输入哈希: ${job.inputHash}）。`,
    ...(policyLine ? [policyLine] : []),
    '请严格依据 context.json 中的 reviewSnapshot 冻结资产与任务需求进行专业审查，先给出简明中文分析，并在回复末尾附带如下格式的 JSON 代码块（以便平台一键填入或提交评审报告）：',
    '```taskflow-review-draft\n{\n  "summary": "评审总体结论与核心依据",\n  "evidence": "核对的材料版本、代码位置或验证说明",\n  "findings": [\n    {\n      "severity": "WARN",\n      "title": "问题简述（无问题时 findings 留空数组 []）",\n      "detail": "详细原因与修改建议",\n      "location": "文件路径或文档章节"\n    }\n  ]\n}\n```',
    '约束：只客观输出审查结果（CRITICAL / WARN / INFO），不要虚构未核实的执行证据，不要修改代码文件或外部系统。',
  ].join('\n\n');
}
