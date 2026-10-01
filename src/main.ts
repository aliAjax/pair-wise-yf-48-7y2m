import { createApp } from "vue";
import { createPinia } from "pinia";
import { createI18n } from "vue-i18n";
import App from "./App.vue";
import { router } from "./router";
import "./styles.css";

const i18n = createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": { scoring: "匿名评分", schemes: "方案浏览", results: "结果管理" } } });
createApp(App).use(createPinia()).use(router).use(i18n).mount("#root");
