// The admin repo's copy of the platform's types (src/platform-api.d.ts) checked against the real ones at the platform's
// main. Only tsconfig.contract.json compiles this, and there @platform/admin-api is the platform's real file.
// What the platform answers must fit the copy (admin reads it); what admin sends must fit the platform (it accepts it).
// It catches a removed, renamed or changed field or type. It doesn't catch a field the platform adds.
import type * as Local from "../src/platform-api";
import type * as Real from "@platform/admin-api";

type Fits<A extends B, B> = [A, B];
type Answer<M extends keyof Real.AdminApi> = Real.AdminApi[M] extends (...a: never[]) => Promise<infer R> ? R : never;

export type AnswersFit = [
  Fits<Real.Summary, Local.Summary>, Fits<Real.Overview, Local.Overview>, Fits<Real.UsersPage, Local.UsersPage>,
  Fits<Real.ContentPage, Local.ContentPage>, Fits<Real.DataSources, Local.DataSources>, Fits<Real.JobsList, Local.JobsList>,
  Fits<Answer<"summary">, Local.Summary>, Fits<Answer<"overview">, Local.Overview>, Fits<Answer<"users">, Local.UsersPage>,
  Fits<Answer<"content">, Local.ContentPage>, Fits<Answer<"dataSources">, Local.DataSources>, Fits<Answer<"jobs">, Local.JobsList>,
];
export type ArgumentsFit = [
  Fits<Local.UsersArgs, Real.UsersArgs>, Fits<Local.ContentArgs, Real.ContentArgs>,
  Fits<Local.Range, Real.Range>, Fits<Real.Range, Local.Range>,
  Fits<Local.UserRole, Real.UserRole>, Fits<Real.UserRole, Local.UserRole>,
  Fits<Local.ContentScreen, Real.ContentScreen>, Fits<Real.ContentScreen, Local.ContentScreen>,
  Fits<Local.ContentStatus, Real.ContentStatus>, Fits<Real.ContentStatus, Local.ContentStatus>,
];
