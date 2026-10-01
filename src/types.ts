export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type JudgeName = Exclude<Viewer, "主办方">;
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

export interface ScoreRecord {
  id: string;
  judge: JudgeName;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  /** 已确认（提交） */
  submitted: boolean;
  /** 声明利益冲突，保留审计记录但不计入排名 */
  conflict: boolean;
  /** 评分所基于的权重版本；与当前权重版本不一致即旧版评分，需重新确认 */
  weightVersion: number;
  /** 乐观并发版本号：已确认版本每被覆盖一次 +1 */
  rev: number;
  /** 最近一次确认（提交）时间，同基准并发提交时后确认者胜 */
  confirmedAt: string | null;
  /** 最近一次写入该记录的操作 id，用于重试幂等 */
  lastOpId?: string;
  updatedAt: string;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}

export interface WeightState {
  version: number;
  updatedAt: string;
  updatedBy: Viewer;
}

export type OutboxKind = "save" | "submit" | "recall" | "conflict" | "weights" | "publish";

export interface OutboxEntry {
  opId: string;
  kind: OutboxKind;
  label: string;
  op: Op;
  createdAt: string;
  attempts: number;
  /** 重试时服务器返回冲突，停止自动重试，等待评委处理 */
  blockedByConflict?: boolean;
  /** 并发冲突中胜出方的确认时间 */
  winnerConfirmedAt?: string;
  /** 锁定/非法状态等终态拒绝原因，不再自动重试 */
  rejectedReason?: string;
}

/** 本地未上云草稿（切窗口/断网时都不能丢分） */
export interface LocalDraft {
  judge: JudgeName;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  /** 声明利益冲突，保留审计记录但不计入排名 */
  conflict: boolean;
  /** 草稿所依据的服务器 rev */
  baseRev: number;
  /** 草稿所依据的权重版本 */
  weightVersion: number;
  /** 有未保存编辑 */
  pending: boolean;
  /** 提交时检测到另一窗口后确认，服务器采用了对方版本 */
  clash: boolean;
}

export type Op =
  | { type: "save"; opId: string; judge: JudgeName; schemeId: string; values: Record<string, number>; comment: string; conflict: boolean }
  | { type: "submit"; opId: string; judge: JudgeName; schemeId: string; values: Record<string, number>; comment: string; conflict: boolean; baseRev: number; confirmedAt: string }
  | { type: "recall"; opId: string; judge: JudgeName; schemeId: string }
  | { type: "setConflict"; opId: string; judge: JudgeName; schemeId: string; conflict: boolean }
  | { type: "weights"; opId: string; weights: Record<string, number>; actor: Viewer; at: string }
  | { type: "publish"; opId: string; actor: Viewer; at: string };

export type DispatchResult =
  | { ok: true; duplicated?: boolean; conflicted?: false }
  | { ok: false; reason: "conflict"; winnerConfirmedAt: string }
  | { ok: false; reason: "locked" | "invalid" };
