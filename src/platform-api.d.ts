// The platform's AdminApi as the admin Worker sees it: a copy of the types in the public repo's src/routes/admin-api.ts
// (TalkHalifax/talkhalifax, main). Types only, so nothing here is bundled or deployed. CI's contract check type-checks
// src/ against the real file, and test/contract.ts checks this copy against it. When either fails, make this copy match
// the real file, then fix the code that uses it.
import { WorkerEntrypoint } from "cloudflare:workers";

export type Range = "24h" | "7d" | "30d";
export type UserRole = "all" | "member" | "moderator" | "journalist" | "banned";
export type ContentScreen = "all" | "Developing" | "Articles" | "Notices" | "Events";
export type ContentStatus = "all" | "waiting" | "active" | "archived";

/** Users, after checking: q is trimmed, lowercased and at most 60 characters. */
export interface UsersArgs { q: string; role: UserRole; offset: number }
/** Content, after checking: q is trimmed, lowercased and at most 100 characters. */
export interface ContentArgs { screen: ContentScreen; status: ContentStatus; q: string }

export interface Job { name: string; does: string; every: string; lastAt: number | null; state: "ok" | "late" | "failing"; failures: number }
export interface JobsList { jobs: Job[] }

export interface Summary {
  members: number; newThisWeek: number; postedThisWeek: number; banned: number; openReports: number; drafts: number;
  pendingUpdates: number; developing: number; notices: number; articles: number; inRooms: number;
  events: number; jobs: Job[];
}

export interface Overview {
  range: Range;
  labels: string[];
  series: { online: number[]; signups: number[]; messages: number[]; impressions: number[]; clicks: number[] };
  onlineNow: number;
  countingSince: number | null;
}

export interface UserRow {
  id: string; name: string; username: string | null; role: string; banned: number; joined: number;
  messages: number; lastPost: number | null; openReports: number;
}
export interface UsersPage { users: UserRow[]; total: number; pageSize: number }

export interface ContentItem {
  id: string; title: string; screen: string; status: string; label: string; source: string; updatedAt: string | null;
  version: number | null; messages: number | null; impressions: number | null; clicks: number | null; url: string | null;
}
export interface ContentPage { items: ContentItem[]; total: number; limit: number }

export interface DataSources {
  feeds: { name: string; shows: string; lastAt: number | null; state: "missing" | "late" | "ok" }[];
  sources: { name: string; stories: number; last: string }[];
}

/** The six read-only methods, called over the PLATFORM service binding. */
export declare class AdminApi extends WorkerEntrypoint<unknown> {
  summary(): Promise<Summary>;
  overview(range?: unknown): Promise<Overview>;
  users(args?: unknown): Promise<UsersPage>;
  content(args?: unknown): Promise<ContentPage>;
  dataSources(): Promise<DataSources>;
  jobs(): Promise<JobsList>;
}
