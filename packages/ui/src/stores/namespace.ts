import { ref } from 'vue';
import { defineStore } from 'pinia';
import { apiClient } from '../api/client';

export const useNamespaceStore = defineStore('namespace', () => {
  const namespaces = ref<string[]>([]);
  const current = ref<string>(localStorage.getItem('a5e:namespace') ?? 'default');

  async function load() {
    const result = await apiClient.get<{ items: { name: string }[] }>('/namespaces');
    namespaces.value = result.items.map((n) => n.name);
    if (!namespaces.value.includes(current.value) && namespaces.value.length > 0) {
      current.value = namespaces.value[0]!;
    }
  }

  function setCurrent(ns: string) {
    current.value = ns;
    localStorage.setItem('a5e:namespace', ns);
  }

  return { namespaces, current, load, setCurrent };
});
