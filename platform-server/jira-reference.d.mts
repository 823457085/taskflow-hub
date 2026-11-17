export interface JiraReference { key: string; url: string | null }
export function parseJiraReference(value: unknown): JiraReference;
export function jiraReferenceMatchesSource(reference: JiraReference, baseUrl: string): boolean;
