import { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../components/Button.tsx";
import { TagInput } from "./TagInput.tsx";

export interface EditorProps {
  class?: string;
  previewUrl: string;
  draftUrl: string;
}

export function Editor(props: EditorProps) {
  const [previewHtml, setPreviewHtml] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [updated, setUpdated] = useState(Date.now());
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftUpdated, setDraftUpdated] = useState(Date.now());

  function onInput(event: JSX.TargetedEvent<HTMLTextAreaElement>) {
    const markup = (event.target as HTMLTextAreaElement).value;
    setContent(markup);
    setUpdated(Date.now());
    // TODO: spinner
    fetch(props.previewUrl, {
      method: "POST",
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
      body: markup,
    })
      .then((response) => response.text())
      .then(setPreviewHtml);
  }

  useEffect(() => {
    const handle = setInterval(() => {
      const now = Date.now();
      if (now - draftUpdated < 5000) return;
      if (now - updated < 5000) return;
      if (
        draftTitle === title && draftContent === content &&
        draftTags.length === tags.length && draftTags.every((v, i) =>
          tags[i] === v
        )
      ) return;
      fetch(props.draftUrl, {
        method: "PUT",
        body: JSON.stringify({ title, content, tags }),
        headers: {
          "Content-Type": "application/json",
        },
      }).then(() => {
        setDraftTitle(title);
        setDraftContent(content);
        setDraftTags(tags);
        setDraftUpdated(now);
      });
    }, 1000);

    return () => clearInterval(handle);
  }, [
    props.draftUrl,
    title,
    content,
    tags,
    draftTitle,
    draftContent,
    draftUpdated,
    updated,
  ]);

  return (
    <div class={`flex ${props.class}`}>
      <div class="basis-1/2 flex flex-col">
        <div class="border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
          <input
            type="text"
            required
            placeholder="Article title"
            class="w-full text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none"
            onInput={(event) =>
              setTitle((event.target as HTMLInputElement).value)}
          />
        </div>
        <div class="grow">
          <textarea
            required
            placeholder="Write your article here. You can use Markdown."
            class="w-full h-full text-xl p-3 dark:bg-stone-900 dark:text-white border-4 border-transparent focus:border-stone-200 dark:focus:border-stone-700 focus:outline-none font-mono"
            onInput={onInput}
          />
        </div>
      </div>
      <div class="basis-1/2 flex flex-col border-l-[1px] border-l-stone-300 dark:border-l-stone-600">
        <div class="flex border-b-[1px] border-b-stone-300 dark:border-b-stone-600">
          <TagInput class="grow" onTagsChange={setTags} />
          <Button onClick={() => alert("Not implemented yet.")}>Publish</Button>
        </div>
        <div class="grow overflow-y-scroll p-4 text-xl">
          <div
            class="prose dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>
    </div>
  );
}
