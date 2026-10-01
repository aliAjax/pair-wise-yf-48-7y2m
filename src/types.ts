export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
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
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  conflict: boolean;
  updatedAt: string;
  version: number;
  confirmedWeightVersion: number;
  localDraft?: boolean;
}

export interface PendingSave {
  id: string;
  schemeId: string;
  judge: Viewer;
  values: Record<string, number>;
  comment: string;
  conflict: boolean;
  submitted: boolean;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string;
  error?: string;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
