import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJiraReference, jiraReferenceMatchesSource } from '../platform-server/jira-reference.mjs';

test('Jira keys and ordinary browse, issue and board links identify one issue', () => {
  assert.deepEqual(parseJiraReference(' sample-562 '), { key: 'SAMPLE-562', url: null });
  for (const link of ['https://jira.example.com/browse/SAMPLE-562?filter=myopenissues#comment-1', 'https://jira.example.com/projects/SAMPLE/issues/SAMPLE-562', 'https://jira.example.com/jira/software/c/projects/SAMPLE/boards/1?selectedIssue=SAMPLE-562']) assert.equal(parseJiraReference(link).key, 'SAMPLE-562');
});
test('ambiguous, credential-bearing and invalid references are rejected without echoing input', () => {
  for (const value of ['', 'SAMPLE-0', {}, 'x'.repeat(2049), 'javascript:SAMPLE-562', 'https://user:private-value@jira.example.com/browse/SAMPLE-562', 'https://jira.example.com/browse/SAMPLE-562?selectedIssue=SAMPLE-9', 'https://jira.example.com/?selectedIssue=SAMPLE-1&selectedIssue=SAMPLE-2', 'https://jira.example.com/issues/?jql=project%3DAPEX', 'https://jira.example.com/browse/SAMPLE-562?token=private-value', 'https://jira.example.com/browse/SAMPLE-562#token=private-value']) assert.throws(() => parseJiraReference(value), error => !error.message.includes('private-value'));
});
test('reference sources match exact origin and configured context path boundaries', () => {
  const ref = parseJiraReference('https://jira.example.com/jira/browse/SAMPLE-562');
  assert.equal(jiraReferenceMatchesSource(ref, 'https://jira.example.com/jira'), true);
  for (const base of ['https://jira.example.com/other', 'https://jira.example.com/jir', 'https://jira.example.com:8443/jira', 'https://other.example.com/jira', 'http://jira.example.com/jira']) assert.equal(jiraReferenceMatchesSource(ref, base), false);
  assert.equal(jiraReferenceMatchesSource(parseJiraReference('SAMPLE-562'), 'https://jira.example.com'), true);
});
