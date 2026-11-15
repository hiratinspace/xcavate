import type { z } from "zod";
import type * as S from "./schemas.js";

export type Category = z.infer<typeof S.CategorySchema>;
export type Severity = z.infer<typeof S.SeveritySchema>;
export type Verdict = z.infer<typeof S.VerdictSchema>;
export type PolicyKind = z.infer<typeof S.PolicyKindSchema>;
export type PageType = z.infer<typeof S.PageTypeSchema>;
export type PolicyInput = z.infer<typeof S.PolicyInputSchema>;
export type AnalyzeRequest = z.infer<typeof S.AnalyzeRequestSchema>;
export type Flag = z.infer<typeof S.FlagSchema>;
export type TrialInfo = z.infer<typeof S.TrialInfoSchema>;
export type CancellationInfo = z.infer<typeof S.CancellationInfoSchema>;
export type PolicyMeta = z.infer<typeof S.PolicyMetaSchema>;
export type ChangeSummary = z.infer<typeof S.ChangeSummarySchema>;
export type Report = z.infer<typeof S.ReportSchema>;
export type FeeLine = z.infer<typeof S.FeeLineSchema>;
export type FeeSummary = z.infer<typeof S.FeeSummarySchema>;
export type DarkPatternFinding = z.infer<typeof S.DarkPatternFindingSchema>;
export type WatcherFinding = z.infer<typeof S.WatcherFindingSchema>;
export type LlmFinding = z.infer<typeof S.LlmFindingSchema>;
export type LlmOutput = z.infer<typeof S.LlmOutputSchema>;
export type Golden = z.infer<typeof S.GoldenSchema>;

export type TabStatus = "idle" | "checking" | "ready" | "error";
