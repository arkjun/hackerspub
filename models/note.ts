import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Disk } from "flydrive";
import type Keyv from "keyv";
import sharp from "sharp";
import type { Database } from "../db.ts";
import { getNote } from "../federation/objects.ts";
import { syncPostFromNoteSource, updateRepliesCount } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  accountTable,
  type Actor,
  type Following,
  followingTable,
  type Instance,
  type Mention,
  type NewNoteSource,
  type NoteMedium,
  noteMediumTable,
  type NoteSource,
  noteSourceTable,
  type Post,
  type PostMedium,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export async function createNoteSource(
  db: Database,
  source: Omit<NewNoteSource, "id"> & { id?: Uuid },
): Promise<NoteSource | undefined> {
  const rows = await db.insert(noteSourceTable)
    .values({ id: generateUuidV7(), ...source })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

export async function getNoteSource(
  db: Database,
  username: string,
  id: Uuid,
  signedAccount?: Account & { actor: Actor },
): Promise<
  NoteSource & {
    account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    post: Post & {
      actor: Actor & { followers: Following[] };
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget:
            | Post & {
              actor: Actor & { followers: Following[] };
              mentions: Mention[];
              media: PostMedium[];
            }
            | null;
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & { followers: Following[] };
          mentions: Mention[];
          media: PostMedium[];
        }
        | null;
      mentions: Mention[];
      media: PostMedium[];
      shares: Post[];
    };
    media: NoteMedium[];
  } | undefined
> {
  let account = await db.query.accountTable.findFirst({
    where: eq(accountTable.username, username),
  });
  if (account == null) {
    account = await db.query.accountTable.findFirst({
      where: and(
        eq(accountTable.oldUsername, username),
        isNotNull(accountTable.usernameChanged),
      ),
      orderBy: desc(accountTable.usernameChanged),
    });
  }
  if (account == null) return undefined;
  return await db.query.noteSourceTable.findFirst({
    with: {
      account: {
        with: { emails: true, links: true },
      },
      post: {
        with: {
          actor: {
            with: { followers: true },
          },
          mentions: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      followers: {
                        where: signedAccount == null ? sql`false` : eq(
                          followingTable.followerId,
                          signedAccount.actor.id,
                        ),
                      },
                    },
                  },
                  mentions: true,
                  media: true,
                },
              },
              media: true,
              shares: {
                where: signedAccount == null
                  ? sql`false`
                  : eq(postTable.actorId, signedAccount.actor.id),
              },
            },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  followers: {
                    where: signedAccount == null ? sql`false` : eq(
                      followingTable.followerId,
                      signedAccount.actor.id,
                    ),
                  },
                },
              },
              mentions: true,
              media: true,
            },
          },
          media: true,
          shares: {
            where: signedAccount == null
              ? sql`false`
              : eq(postTable.actorId, signedAccount.actor.id),
          },
        },
      },
      media: true,
    },
    where: and(
      eq(noteSourceTable.id, id),
      eq(noteSourceTable.accountId, account.id),
    ),
  });
}

export async function createNoteMedium(
  db: Database,
  disk: Disk,
  sourceId: Uuid,
  index: number,
  medium: { blob: Blob; alt: string },
): Promise<NoteMedium | undefined> {
  const image = sharp(await medium.blob.arrayBuffer());
  const { width, height } = await image.metadata();
  if (width == null || height == null) return undefined;
  const buffer = await image.webp().toBuffer();
  const key = `note-media/${crypto.randomUUID()}.webp`;
  await disk.put(key, new Uint8Array(buffer));
  const result = await db.insert(noteMediumTable).values({
    sourceId,
    index,
    key,
    alt: medium.alt,
    width,
    height,
  }).returning();
  return result.length > 0 ? result[0] : undefined;
}

export async function createNote(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<void>,
  source: Omit<NewNoteSource, "id"> & {
    id?: Uuid;
    media: { blob: Blob; alt: string }[];
  },
  replyTarget?: Post,
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    media: PostMedium[];
  } | undefined
> {
  const noteSource = await createNoteSource(db, source);
  if (noteSource == null) return undefined;
  let index = 0;
  const media = [];
  for (const medium of source.media) {
    const m = await createNoteMedium(db, disk, noteSource.id, index, medium);
    if (m != null) media.push(m);
    index++;
  }
  const account = await db.query.accountTable.findFirst({
    where: eq(accountTable.id, source.accountId),
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromNoteSource(db, kv, disk, fedCtx, {
    ...noteSource,
    media,
    account,
  }, replyTarget);
  if (replyTarget != null) await updateRepliesCount(db, replyTarget.id);
  const noteObject = await getNote(
    db,
    disk,
    fedCtx,
    { ...noteSource, media, account },
    replyTarget == null ? undefined : new URL(replyTarget.iri),
  );
  await fedCtx.sendActivity(
    { identifier: source.accountId },
    "followers",
    new vocab.Create({
      id: new URL("#create", noteObject.id ?? fedCtx.origin),
      actors: noteObject.attributionIds,
      tos: noteObject.toIds,
      ccs: noteObject.ccIds,
      object: noteObject,
    }),
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  return post;
}

export async function updateNoteSource(
  db: Database,
  noteSourceId: Uuid,
  source: Partial<NewNoteSource>,
): Promise<NoteSource | undefined> {
  const rows = await db.update(noteSourceTable)
    .set({ ...source, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(noteSourceTable.id, noteSourceId))
    .returning();
  return rows[0];
}

export async function updateNote(
  db: Database,
  kv: Keyv,
  disk: Disk,
  fedCtx: Context<void>,
  noteSourceId: Uuid,
  source: Partial<NewNoteSource>,
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    noteSource: NoteSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      media: NoteMedium[];
    };
    mentions: Mention[];
    media: PostMedium[];
  } | undefined
> {
  const noteSource = await updateNoteSource(db, noteSourceId, source);
  if (noteSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: eq(accountTable.id, noteSource.accountId),
    with: { emails: true, links: true },
  });
  const media = await db.query.noteMediumTable.findMany({
    where: eq(noteMediumTable.sourceId, noteSourceId),
  });
  if (account == null) return undefined;
  const post = await syncPostFromNoteSource(db, kv, disk, fedCtx, {
    ...noteSource,
    account,
    media,
  });
  const noteObject = await getNote(
    db,
    disk,
    fedCtx,
    { ...noteSource, media, account },
    post.replyTargetId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: eq(postTable.id, post.replyTargetId),
      }).then((r) => r?.iri == null ? undefined : new URL(r.iri)),
  );
  await fedCtx.sendActivity(
    { identifier: noteSource.accountId },
    "followers",
    new vocab.Update({
      id: new URL(
        `#update/${noteSource.updated.toISOString()}`,
        noteObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: noteObject.attributionIds,
      tos: noteObject.toIds,
      ccs: noteObject.ccIds,
      object: noteObject,
    }),
    {
      preferSharedInbox: true,
      excludeBaseUris: [
        new URL(fedCtx.origin),
        new URL(fedCtx.canonicalOrigin),
      ],
    },
  );
  return post;
}
