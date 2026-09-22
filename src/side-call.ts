import type { Context } from "@earendil-works/pi-ai";
import { messageContentToText } from "./convert.js";
import type { PromptCaptures } from "./prompt-capture.js";

// Standalone side calls: an extension asking the model a question through
// `modelRegistry.streamSimple` with its own system prompt and no tools — pi-btw's
// /btw is the one that prompted this. Such a call never passes through the agent
// loop, so no capture boundary records its prompt and resolveOrDerive would throw.
// Throwing there protects a *turn* from losing the user's context files and skills;
// a side call carries none of those — its prompt is its whole instruction set — so
// the throw guards nothing and only breaks the extension.
//
// Routing it into the provider's session path would be worse than the throw:
// syncSharedSession would read the side conversation as the live transcript,
// forcing a rebuild of the main Claude Code session (and a flushed prompt cache)
// or importing the side thread into it. So side calls go to the isolated path.

/** A call the capture resolver cannot account for and that carries no tools.
 *
 *  Tools are the discriminator because an agent turn always has them unless the
 *  user runs with none — and then its prompt was recorded at before_agent_start,
 *  so `accounts` matches it and it never reaches here. A tooled turn whose prompt
 *  we lost track of still falls through and throws, as it should. */
export function isStandaloneSideCall(context: Context, captures: Pick<PromptCaptures, "accounts">): boolean {
	return !context.tools?.length && Boolean(context.systemPrompt) && !captures.accounts(context.systemPrompt);
}

type Message = Context["messages"][number];

function textOf(message: Message): string {
	if (message.role === "assistant") {
		return message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text" && Boolean(block.text))
			.map((block) => block.text)
			.join("\n");
	}
	return messageContentToText(message.content as Parameters<typeof messageContentToText>[0]);
}

/** One prompt string for the isolated path, which runs a single persistSession:false
 *  turn. A follow-up in a side thread arrives as user/assistant/…/user; the isolated
 *  path has no transcript to resume, so earlier turns are folded in ahead of the
 *  current message rather than dropped. Returns null when the last message is not
 *  from the user. */
export function foldSideCallPrompt(messages: Context["messages"]): string | null {
	let start = messages.length;
	while (start > 0 && messages[start - 1].role === "user") start--;
	if (start === messages.length) return null;

	const current = messages.slice(start).map(textOf).filter(Boolean).join("\n");
	const history = messages.slice(0, start)
		.map((message) => {
			const text = textOf(message);
			if (!text) return undefined;
			const speaker = message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "Tool result";
			return `${speaker}:\n${text}`;
		})
		.filter((entry): entry is string => Boolean(entry));
	if (history.length === 0) return current;
	return `<conversation_so_far>\n${history.join("\n\n")}\n</conversation_so_far>\n\n${current}`;
}
