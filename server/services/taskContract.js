function cleanInline(value, fallback = '') {
  const text = value === undefined || value === null ? fallback : String(value);
  return text.replace(/\r?\n+/g, ' ').trim();
}

function sanitizeTaskId(taskId) {
  const safe = cleanInline(taskId, 'task')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || 'task';
}

function list(value) {
  return Array.isArray(value)
    ? value.map((item) => cleanInline(item)).filter(Boolean)
    : [];
}

function yamlScalar(key, value, fallback = '') {
  return `${key}: ${cleanInline(value, fallback)}`;
}

function yamlList(key, value) {
  const items = list(value);
  if (!items.length) return `${key}: []`;
  return [`${key}:`, ...items.map((item) => `  - ${item}`)].join('\n');
}

function bulletList(items, emptyText = 'None') {
  const rows = list(items);
  if (!rows.length) return `- ${emptyText}`;
  return rows.map((item) => `- \`${item}\``).join('\n');
}

function acceptanceItems(acceptance) {
  const text = acceptance === undefined || acceptance === null ? '' : String(acceptance);
  return text
    .split(/[；;。\n]+/)
    .map((item) => item.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(Boolean);
}

function acceptanceChecklist(acceptance) {
  const items = acceptanceItems(acceptance);
  if (!items.length) return '- [ ] [待产品确认验收标准]';
  return items.map((item) => `- [ ] ${item}`).join('\n');
}

export function taskContractPath(taskId) {
  return `.hub/${sanitizeTaskId(taskId)}.md`;
}

export function buildTaskContractMarkdown(task = {}, context = {}) {
  const taskId = cleanInline(task.id, 'task');
  const title = cleanInline(task.title, 'Untitled task');
  const businessNote = cleanInline(task.businessNote, cleanInline(task.description, 'No business goal provided.'));
  const description = cleanInline(task.description, cleanInline(task.signal, 'No task description provided.'));
  const hubUrl = cleanInline(context.hubUrl, 'https://hub.cueai.top');

  const frontmatter = [
    '---',
    'generated_by: cue-hub',
    'canonical_source: cue-db',
    'contract_version: 1',
    yamlScalar('id', taskId),
    yamlScalar('title', title),
    yamlScalar('status', task.status, 'pending'),
    yamlScalar('priority', task.priority, 'P2'),
    yamlScalar('owner', task.owner, '待认领'),
    yamlScalar('milestoneId', task.milestoneId, ''),
    yamlScalar('sourceDoc', task.sourceDoc, ''),
    yamlScalar('projectName', context.projectName, ''),
    yamlScalar('branchName', context.branchName, ''),
    yamlList('dependencies', task.dependencies),
    yamlList('requirementRefs', task.requirementRefs),
    yamlList('evidenceRefs', task.evidenceRefs),
    '---'
  ].join('\n');

  return `${frontmatter}

# Task Contract · ${title}

> Generated from CUE DB/store. CUE DB/store is the source of truth for this task.
> Do not edit status, evidenceRefs, or linked PR fields by hand in this markdown file.

## Business Goal

${businessNote}

## Task Description

${description}

## Acceptance Criteria

${acceptanceChecklist(task.acceptance)}

## Dependencies

${bulletList(task.dependencies)}

## Requirement Refs

${bulletList(task.requirementRefs)}

## Completion Evidence

${bulletList(task.evidenceRefs, 'No evidence recorded yet')}

## Execution Notes

- Work on branch \`${cleanInline(context.branchName, 'the task branch')}\`.
- Reference this task id in commits and PRs: \`${taskId}\`.
- Keep PR changes scoped to the acceptance criteria above.
- Let CUE write evidenceRefs after PR creation or merge.
- Hub task: ${hubUrl}
`;
}

export function parseTaskContractFrontmatter(markdown = '') {
  const text = String(markdown || '');
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result = {};
  let currentListKey = '';

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const listItem = line.match(/^\s+-\s*(.*)$/);
    if (listItem && currentListKey) {
      result[currentListKey].push(listItem[1].trim());
      continue;
    }

    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      currentListKey = '';
      continue;
    }

    const [, key, value] = pair;
    if (value === '') {
      result[key] = [];
      currentListKey = key;
    } else if (value === '[]') {
      result[key] = [];
      currentListKey = '';
    } else {
      result[key] = value.trim();
      currentListKey = '';
    }
  }

  return result;
}

function checklistItems(markdown = '') {
  return String(markdown || '')
    .split('\n')
    .map((line) => line.match(/^- \[ \]\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

export function validateTaskContract(task = {}, markdown = '') {
  const meta = parseTaskContractFrontmatter(markdown);
  const issues = [];

  if (meta.canonical_source !== 'cue-db') {
    issues.push({
      code: 'canonical_source_missing',
      message: 'Task contract must declare canonical_source: cue-db'
    });
  }

  const expectedId = cleanInline(task.id);
  if (expectedId && meta.id !== expectedId) {
    issues.push({
      code: 'id_mismatch',
      message: `Task contract id ${meta.id || '(missing)'} does not match ${expectedId}`
    });
  }

  const expectedAcceptance = acceptanceItems(task.acceptance);
  const actualAcceptance = checklistItems(markdown);
  if (expectedAcceptance.join('\n') !== actualAcceptance.join('\n')) {
    issues.push({
      code: 'acceptance_mismatch',
      message: 'Task contract acceptance checklist differs from CUE task acceptance'
    });
  }

  return { ok: issues.length === 0, issues, frontmatter: meta };
}
