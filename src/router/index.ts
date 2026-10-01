import { createRouter, createWebHashHistory } from "vue-router";
import ScoreView from "../views/ScoreView.vue";
import ResultView from "../views/ResultView.vue";
export const router = createRouter({ history: createWebHashHistory(), routes: [{ path: "/", component: ScoreView }, { path: "/results", component: ResultView }] });
