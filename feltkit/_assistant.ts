/** The TaskFlow assistant's identity and how people address it. Shared by comments.ts and assistant.ts. */
export const ASSISTANT_ID = "taskflow-assistant";

/** "@assistant follow up: <title>" (or "file:"), anywhere in a comment → the title; otherwise null. */
export function assistantRequest(body: string): string | null {
  const m = /(?:^|\s)@assistant\s+(?:follow[\s-]?up|file)\s*:?\s*(.+)/i.exec(body);
  const title = m?.[1]?.split("\n")[0]?.trim();
  return title ? title.slice(0, 200) : null;
}
