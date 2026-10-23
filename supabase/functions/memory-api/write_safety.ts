const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{20,}/;
const OPENAI_KEY = /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/;
const GITHUB_TOKEN = /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/;
const BEARER_HEADER = /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{20,}/i;
const TRANSCRIPT_LINE = /^(?:User|Human|Assistant|Claude|AI)\s*:/;

export function unsafeReasons(text: string): string[] {
  if (typeof text !== "string") return [];
  const reasons: string[] = [];
  const anthropic = ANTHROPIC_KEY.test(text);
  if (anthropic) reasons.push("secret:anthropic_key");
  else if (OPENAI_KEY.test(text)) reasons.push("secret:openai_key");
  if (JWT.test(text)) reasons.push("secret:jwt");
  if (PRIVATE_KEY.test(text)) reasons.push("secret:private_key");
  if (AWS_ACCESS_KEY.test(text)) reasons.push("secret:aws_access_key");
  if (GITHUB_TOKEN.test(text)) reasons.push("secret:github_token");
  if (BEARER_HEADER.test(text)) reasons.push("secret:bearer_header");
  if (text.split(/\r?\n/).filter((line) => TRANSCRIPT_LINE.test(line)).length >= 8) {
    reasons.push("transcript:raw");
  }
  if (text.length > 32768) reasons.push("size:over_limit");
  return reasons;
}
