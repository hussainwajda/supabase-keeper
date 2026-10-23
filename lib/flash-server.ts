import "server-only";
import { cookies } from "next/headers";
import { FLASH_COOKIE, type Flash, type FlashTone } from "./flash";

/**
 * One-shot messages that survive a redirect.
 *
 * Most actions here end in `redirect("/")`, which throws — so an action can't return "Project
 * saved" to the form it came from, because that form is already gone. The message has to
 * outlive the navigation, and a short-lived cookie is the only channel that does.
 *
 * Deliberately *not* `httpOnly`: the client component that shows the toast is also what
 * deletes the cookie. A Server Component can read cookies during render but can't write them,
 * so the server has no way to consume a flash it just read — leaving the clearing to the
 * client is what stops the same toast firing again on the next render.
 */

/** Set from a server action, immediately before `redirect()`. */
export async function setFlash(
  message: string,
  tone: FlashTone = "success",
  description?: string,
): Promise<void> {
  const store = await cookies();
  store.set(FLASH_COOKIE, JSON.stringify({ message, tone, description } satisfies Flash), {
    path: "/",
    // Long enough to survive the redirect, short enough that a tab left open overnight
    // doesn't greet you with yesterday's message.
    maxAge: 30,
    httpOnly: false,
    sameSite: "lax",
  });
}

/** Read during a layout or page render. Clearing is the client's job — see `FlashToaster`. */
export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Flash>;
    if (typeof parsed.message !== "string" || !parsed.message) return null;
    const tone: FlashTone =
      parsed.tone === "error" || parsed.tone === "info" ? parsed.tone : "success";
    return {
      message: parsed.message,
      tone,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
    };
  } catch {
    // A malformed cookie is someone else's problem, not a 500 on every page.
    return null;
  }
}
