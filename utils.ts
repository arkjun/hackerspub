/// <reference lib="deno.unstable" />
import { createDefine } from "fresh";
import { Session } from "./models/session.ts";
import { validate as validateUuidV1To5 } from "@std/uuid";
import { validate as validateUuidV7 } from "@std/uuid/unstable-v7";
import { RequestContext } from "@fedify/fedify";

export interface Link {
  rel: string;
  href: string | URL;
  hreflang?: string;
  type?: string;
}

export type Meta = {
  name: string;
  content: string | number | URL;
} | {
  property: string;
  content: string | number | URL;
};

export interface State {
  session?: Session;
  fedCtx: RequestContext<void>;
  title: string;
  metas: Meta[];
  links: Link[];
}

export const define = createDefine<State>();

export function validateUuid(string: string): boolean {
  return validateUuidV1To5(string) || validateUuidV7(string);
}

export function compactUrl(url: string | URL): string {
  url = new URL(url);
  return url.protocol !== "https:" && url.protocol !== "http:"
    ? url.href
    : url.host +
      (url.searchParams.size < 1 && (url.hash === "" || url.hash === "#")
        ? url.pathname.replace(/\/+$/, "")
        : url.pathname) +
      (url.searchParams.size < 1 ? "" : url.search) +
      (url.hash === "#" ? "" : url.hash);
}
