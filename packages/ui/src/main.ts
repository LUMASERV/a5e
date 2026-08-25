import ElementPlus from 'element-plus';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import 'element-plus/dist/index.css';
import './style.css';
import App from './App.vue';
import { router } from './router';
import { registerChangeRequestInterceptor } from './stores/changeRequestDraft';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);
registerChangeRequestInterceptor(pinia);
app.mount('#app');
