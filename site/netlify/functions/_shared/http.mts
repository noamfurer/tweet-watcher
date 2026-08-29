export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });

export function safeError(error: unknown) {
  if (error instanceof Error && /unauthorized|גישה/i.test(error.message)) return "נדרשת כניסה מחדש";
  return error instanceof Error ? error.message : "הפעולה נכשלה";
}
