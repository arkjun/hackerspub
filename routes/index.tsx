import { getLogger } from "@logtape/logtape";
import { acceptsLanguages } from "@std/http/negotiation";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import {
  TimelineNav,
  type TimelineNavItem,
} from "../components/TimelineNav.tsx";
import { db } from "../db.ts";
import { Composer } from "../islands/Composer.tsx";
import { RecommendedActors } from "../islands/RecommendedActors.tsx";
import { kv } from "../kv.ts";
import { recommendActors } from "../models/actor.ts";
import { extractMentionsFromHtml } from "../models/markup.ts";
import { getPostVisibilityFilter, isPostVisibleTo } from "../models/post.ts";
import type {
  Account,
  Actor,
  Following,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../models/schema.ts";
import { define } from "../utils.ts";

const logger = getLogger(["hackerspub", "routes", "index"]);

const DEFAULT_WINDOW = 50;

export const handler = define.handlers({
  async GET(ctx) {
    const filterString = ctx.url.searchParams.get("filter");
    let filter: TimelineNavItem;
    if (
      filterString === "local" || filterString === "withoutShares" ||
      filterString === "articlesOnly" ||
      ctx.state.account != null &&
        (filterString === "mentionsAndQuotes" ||
          filterString === "recommendations")
    ) {
      filter = filterString;
    } else {
      filter = "fediverse";
    }
    const untilString = ctx.url.searchParams.get("until");
    const until = untilString == null || !untilString.match(/^\d+(\.\d+)?$/)
      ? undefined
      : new Date(parseInt(untilString));
    const windowString = ctx.url.searchParams.get("window");
    const window = windowString == null || !windowString.match(/^\d+$/)
      ? DEFAULT_WINDOW
      : parseInt(windowString);
    let timeline: ({
      post: Post & {
        actor: Actor & { followers: Following[] };
        link: PostLink & { creator?: Actor | null } | null;
        sharedPost:
          | Post & {
            actor: Actor;
            link: PostLink & { creator?: Actor | null } | null;
            replyTarget:
              | Post & {
                actor: Actor & { followers: Following[] };
                link: PostLink & { creator?: Actor | null } | null;
                mentions: (Mention & { actor: Actor })[];
                media: PostMedium[];
              }
              | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
            shares: Post[];
          }
          | null;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
            link: PostLink & { creator?: Actor | null } | null;
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
      };
      lastSharer: Actor | null;
      sharersCount: number;
      added: Date;
    })[];
    const languages = new Set<string>(
      acceptsLanguages(ctx.req)
        .filter((lang) => lang !== "*")
        .map((lang) => lang.replace(/-.*$/, "")),
    );
    logger.debug("Accepted languages: {languages}", { languages });
    if (ctx.state.account == null) {
      const posts = await db.query.postTable.findMany({
        with: {
          actor: { with: { followers: true } },
          link: { with: { creator: true } },
          sharedPost: {
            with: {
              actor: true,
              link: { with: { creator: true } },
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      followers: { where: { RAW: sql`false` } },
                    },
                  },
                  link: { with: { creator: true } },
                  mentions: {
                    with: { actor: true },
                  },
                  media: true,
                },
              },
              mentions: {
                with: { actor: true },
              },
              media: true,
              shares: { where: { RAW: sql`false` } },
            },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  followers: { where: { RAW: sql`false` } },
                },
              },
              link: { with: { creator: true } },
              mentions: {
                with: { actor: true },
              },
              media: true,
            },
          },
          mentions: {
            with: { actor: true },
          },
          media: true,
          shares: { where: { RAW: sql`false` } },
        },
        where: {
          visibility: "public",
          ...(
            languages.size < 1
              ? undefined
              : { language: { in: [...languages] } }
          ),
          replyTargetId: { isNull: true },
          ...(
            filter === "local"
              ? {
                OR: [
                  { noteSourceId: { isNotNull: true } },
                  { articleSourceId: { isNotNull: true } },
                  {
                    sharedPostId: { isNotNull: true },
                    actor: {
                      accountId: { isNotNull: true },
                    },
                  },
                ],
              }
              : filter === "withoutShares"
              ? { sharedPostId: { isNull: true } }
              : filter === "articlesOnly"
              ? { type: "Article" }
              : undefined
          ),
          ...(until == null ? undefined : { published: { lte: until } }),
        },
        orderBy: { published: "desc" },
        limit: window + 1,
      });
      timeline = posts.map((post) => ({
        post,
        lastSharer: null,
        sharersCount: 0,
        added: post.published,
      }));
    } else {
      timeline = filter === "recommendations"
        ? []
        : await db.query.timelineItemTable.findMany({
          with: {
            post: {
              with: {
                actor: { with: { followers: true } },
                link: { with: { creator: true } },
                sharedPost: {
                  with: {
                    actor: true,
                    link: { with: { creator: true } },
                    replyTarget: {
                      with: {
                        actor: {
                          with: {
                            followers: {
                              where: {
                                followerId: ctx.state.account.actor.id,
                              },
                            },
                          },
                        },
                        link: { with: { creator: true } },
                        mentions: {
                          with: { actor: true },
                        },
                        media: true,
                      },
                    },
                    mentions: {
                      with: { actor: true },
                    },
                    media: true,
                    shares: {
                      where: { actorId: ctx.state.account.actor.id },
                    },
                  },
                },
                replyTarget: {
                  with: {
                    actor: {
                      with: {
                        followers: {
                          where: { followerId: ctx.state.account.actor.id },
                        },
                      },
                    },
                    link: { with: { creator: true } },
                    mentions: {
                      with: { actor: true },
                    },
                    media: true,
                  },
                },
                mentions: {
                  with: { actor: true },
                },
                media: true,
                shares: {
                  where: { actorId: ctx.state.account.actor.id },
                },
              },
            },
            lastSharer: true,
          },
          where: {
            accountId: ctx.state.account.id,
            post: {
              AND: [
                getPostVisibilityFilter(ctx.state.account.actor),
                filter === "local"
                  ? {
                    OR: [
                      { noteSourceId: { isNotNull: true } },
                      { articleSourceId: { isNotNull: true } },
                    ],
                  }
                  : filter === "articlesOnly"
                  ? { type: "Article" }
                  : filter === "mentionsAndQuotes"
                  ? {
                    OR: [
                      { mentions: { actorId: ctx.state.account.actor.id } },
                      { quotedPost: { actorId: ctx.state.account.actor.id } },
                    ],
                  }
                  : {},
              ],
            },
            ...(filter === "withoutShares"
              ? { originalAuthorId: { isNotNull: true } }
              : {}),
            ...(until == null ? undefined : { added: { lte: until } }),
          },
          orderBy: filter === "withoutShares"
            ? { added: "desc" }
            : { appended: "desc" },
          limit: window + 1,
        });
      if (filter === "withoutShares") {
        timeline = timeline.map((item) => ({
          ...item,
          lastSharer: null,
          lastSharerId: null,
        }));
      }
    }
    let next: Date | undefined = undefined;
    if (timeline.length > window) {
      next = timeline[window].added;
      timeline = timeline.slice(0, window);
    }
    const recommendedActors = next == null || filter === "recommendations"
      ? await recommendActors(db, {
        mainLocale: ctx.state.locales.length > 0
          ? ctx.state.locales[0]
          : ctx.state.language,
        locales: ctx.state.locales,
        account: ctx.state.account,
        limit: 50,
      })
      : [];
    logger.debug("Recommended actors: {recommendedActors}", {
      recommendedActors,
    });
    const recommendedActorMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      recommendedActors.map((actor) => actor.bioHtml).join("\n"),
      ctx.state.account == null ? { kv } : {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(
          ctx.state.account,
        ),
        kv,
      },
    );
    ctx.state.metas.push(
      { name: "description", content: ctx.state.t("home.intro.content") },
      { property: "og:title", content: "Hackers' Pub" },
      {
        property: "og:description",
        content: ctx.state.t("home.intro.content"),
      },
      {
        property: "og:url",
        content: new URL("/", ctx.state.canonicalOrigin).href,
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: new URL("/og.png", ctx.state.canonicalOrigin).href,
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
    );
    ctx.state.links.push(
      { rel: "canonical", href: new URL("/", ctx.state.canonicalOrigin).href },
    );
    return page<HomeProps>({
      intro: filter !== "recommendations" &&
        (ctx.state.account == null || timeline.length < 1),
      composer: ctx.state.account != null,
      filter,
      timeline: timeline.filter((item) =>
        isPostVisibleTo(item.post, ctx.state.account?.actor)
      ),
      next,
      window,
      recommendedActors,
      recommendedActorMentions,
    });
  },
});

interface HomeProps {
  intro: boolean;
  composer: boolean;
  filter: TimelineNavItem;
  timeline: ({
    post: Post & {
      actor: Actor;
      link: PostLink & { creator?: Actor | null } | null;
      sharedPost:
        | Post & {
          actor: Actor;
          link: PostLink & { creator?: Actor | null } | null;
          replyTarget:
            | Post & {
              actor: Actor & { followers: Following[] };
              link: PostLink & { creator?: Actor | null } | null;
              mentions: (Mention & { actor: Actor })[];
              media: PostMedium[];
            }
            | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & { followers: Following[] };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
    };
    lastSharer: Actor | null;
    sharersCount: number;
    added: Date;
  })[];
  next?: Date;
  window: number;
  recommendedActors: (Actor & { account?: Account | null })[];
  recommendedActorMentions: { actor: Actor }[];
}

export default define.page<typeof handler, HomeProps>(
  function Home({ state, data }) {
    const nextHref = data.next == null
      ? undefined
      : data.window === DEFAULT_WINDOW
      ? `?filter=${data.filter}&until=${+data.next}`
      : `?filter=${data.filter}&until=${+data.next}&window=${data.window}`;
    return (
      <>
        {data.composer && (
          <Composer
            language={state.language}
            postUrl={`/@${state.account!.username}`}
            onPost="reload"
          />
        )}
        {data.intro &&
          (
            <article>
              <PageTitle>
                <Msg $key="home.intro.title" />
              </PageTitle>
              <div class="prose prose-h2:text-xl dark:prose-invert">
                <p>
                  <Msg $key="home.intro.content" />
                </p>
              </div>
            </article>
          )}
        <TimelineNav active={data.filter} signedIn={state.account != null} />
        {data.filter !== "recommendations" && (
          <>
            {data.timeline.map((item) => (
              <PostExcerpt
                post={item.post}
                lastSharer={item.lastSharer}
                sharersCount={item.sharersCount}
                signedAccount={state.account}
              />
            ))}
            <PostPagination nextHref={nextHref} />
          </>
        )}
        {data.recommendedActors.length > 0 && (
          <RecommendedActors
            language={state.language}
            actors={data.recommendedActors}
            actorMentions={data.recommendedActorMentions}
            window={6}
            title={data.filter !== "recommendations"}
            class={data.filter === "recommendations" ? "mt-4" : ""}
          />
        )}
      </>
    );
  },
);
