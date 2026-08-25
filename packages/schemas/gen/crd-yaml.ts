#!/usr/bin/env bun
/**
 * Zod -> JSON Schema -> CRD YAML generator.
 *
 * packages/schemas is the single source of truth for resource shape; this script converts
 * each kind's Zod spec/status schemas into a full CustomResourceDefinition manifest, layering
 * on Kubernetes-only OpenAPI extensions (x-kubernetes-preserve-unknown-fields,
 * x-kubernetes-validations for CEL, list-map-keys for conditions) that zod-to-json-schema has
 * no native concept of. See plan §3.5 for the rationale and fallback if this proves too fiddly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  API_GROUP,
  API_VERSION,
  RESOURCE_DESCRIPTORS,
  type ResourceDescriptor,
} from '../src/crd-meta';
import { JUMP_HOST_CEL, JUMP_HOST_CEL_MESSAGE } from '../src/hosts';
import {
  HOST_SOURCE_CEL_CLUSTER_PARENT,
  HOST_SOURCE_CEL_NAMESPACED_PARENT,
} from '../src/inventories';
import {
  GIT_AUTH_CEL,
  GIT_AUTH_CEL_MESSAGE,
  PLAYBOOK_SOURCE_CEL,
  PLAYBOOK_SOURCE_CEL_MESSAGE,
} from '../src/playbooks';
import { REF_CEL_CLUSTER_KIND_NO_NAMESPACE } from '../src/refs';

// biome-ignore lint/suspicious/noExplicitAny: JSON-schema tree, deliberately untyped
type JSONSchemaNode = Record<string, any>;

/** Path DSL: plain string = descend into properties.<name>; '[]' = descend into items; 'anyOf:N' = descend into anyOf[N]. */
function walk(node: JSONSchemaNode, path: string[]): JSONSchemaNode | undefined {
  let cur = node;
  for (const segment of path) {
    if (!cur) return undefined;
    if (segment === '[]') {
      cur = cur.items;
    } else if (segment.startsWith('anyOf:')) {
      const idx = Number(segment.slice('anyOf:'.length));
      cur = cur.anyOf?.[idx];
    } else {
      cur = cur.properties?.[segment];
    }
  }
  return cur;
}

interface CelExtra {
  path: string[];
  rule: string;
  message: string;
}

function applyCel(root: JSONSchemaNode, extra: CelExtra) {
  const target = walk(root, extra.path);
  if (!target) {
    throw new Error(`CEL extras path not found: ${extra.path.join('.')}`);
  }
  target['x-kubernetes-validations'] = [
    ...(target['x-kubernetes-validations'] ?? []),
    { rule: extra.rule, message: extra.message },
  ];
}

/**
 * Recursively replace fully-open records (additionalProperties: {}) with preserve-unknown-fields,
 * and a completely untyped node (zod-to-json-schema emits `{}` for `z.unknown()`/`z.any()` — no
 * `type` at all) the same way: Kubernetes' structural schema validation rejects any property with
 * no `type`, unless it carries `x-kubernetes-preserve-unknown-fields: true` instead.
 */
function preserveUnknownFields(node: JSONSchemaNode) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'object' &&
    node.additionalProperties &&
    typeof node.additionalProperties === 'object' &&
    Object.keys(node.additionalProperties).length === 0 &&
    !node.properties
  ) {
    // biome-ignore lint/performance/noDelete: one-off codegen script, not a hot path.
    delete node.additionalProperties;
    node['x-kubernetes-preserve-unknown-fields'] = true;
  }
  if (Object.keys(node).length === 0) {
    node['x-kubernetes-preserve-unknown-fields'] = true;
  }
  for (const key of ['properties']) {
    if (node[key])
      for (const v of Object.values(node[key])) preserveUnknownFields(v as JSONSchemaNode);
  }
  if (node.items) preserveUnknownFields(node.items);
  if (node.anyOf) for (const v of node.anyOf) preserveUnknownFields(v);
  if (node.oneOf) for (const v of node.oneOf) preserveUnknownFields(v);
  if (node.allOf) for (const v of node.allOf) preserveUnknownFields(v);
}

/**
 * Kubernetes structural schemas forbid `properties` and `additionalProperties` on the same node
 * (unlike plain JSON Schema/OpenAPI, where they may coexist). zod-to-json-schema always emits
 * `additionalProperties: false` alongside `properties` for object schemas; strip it — Kubernetes
 * already prunes unknown fields by default when `properties` is set, so nothing is lost.
 */
function stripAdditionalPropertiesWithProperties(node: JSONSchemaNode) {
  if (!node || typeof node !== 'object') return;
  if (node.properties && 'additionalProperties' in node) {
    // biome-ignore lint/performance/noDelete: one-off codegen script, not a hot path.
    delete node.additionalProperties;
  }
  if (node.properties)
    for (const v of Object.values(node.properties))
      stripAdditionalPropertiesWithProperties(v as JSONSchemaNode);
  if (node.items) stripAdditionalPropertiesWithProperties(node.items);
  for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
    if (node[combinator])
      for (const v of node[combinator]) stripAdditionalPropertiesWithProperties(v);
  }
}

/** Mark a `conditions: Condition[]` array (if present at the given root) as a merge-map on `type`. */
function annotateConditions(statusRoot: JSONSchemaNode) {
  const conditions = statusRoot.properties?.conditions;
  if (conditions) {
    conditions['x-kubernetes-list-type'] = 'map';
    conditions['x-kubernetes-list-map-keys'] = ['type'];
  }
}

function toJsonSchema(schema: import('zod').ZodTypeAny): JSONSchemaNode {
  const out = zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as JSONSchemaNode;
  // zod-to-json-schema emits a top-level $schema key that CRD schemas don't want.
  // biome-ignore lint/performance/noDelete: one-off codegen script, not a hot path.
  delete out.$schema;
  return out;
}

const CEL_EXTRAS: Record<string, CelExtra[]> = {
  AnsiblePlaybook: [
    { path: ['source'], rule: PLAYBOOK_SOURCE_CEL, message: PLAYBOOK_SOURCE_CEL_MESSAGE },
    { path: ['source', 'git'], rule: GIT_AUTH_CEL, message: GIT_AUTH_CEL_MESSAGE },
  ],
  ClusterAnsiblePlaybook: [
    { path: ['source'], rule: PLAYBOOK_SOURCE_CEL, message: PLAYBOOK_SOURCE_CEL_MESSAGE },
    { path: ['source', 'git'], rule: GIT_AUTH_CEL, message: GIT_AUTH_CEL_MESSAGE },
  ],
  AnsibleHost: [
    { path: ['jumpHost'], rule: JUMP_HOST_CEL, message: JUMP_HOST_CEL_MESSAGE },
    {
      path: ['jumpHost', 'hostRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
    {
      path: ['sshKeyRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
  ],
  ClusterAnsibleHost: [
    { path: ['jumpHost'], rule: JUMP_HOST_CEL, message: JUMP_HOST_CEL_MESSAGE },
    {
      path: ['jumpHost', 'hostRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
    {
      path: ['sshKeyRef'],
      rule: "self.kind == 'ClusterAnsibleSSHKey' || has(self.namespace)",
      message: 'namespace is required when kind is AnsibleSSHKey (this object is cluster-scoped)',
    },
    {
      path: ['sshKeyRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
  ],
  AnsibleInventory: [
    {
      path: ['groups', '[]', 'hostSources', '[]'],
      rule: HOST_SOURCE_CEL_NAMESPACED_PARENT,
      message:
        'namespace must be absent for kind AnsibleHost on a namespaced AnsibleInventory (always own namespace)',
    },
  ],
  ClusterAnsibleInventory: [
    {
      path: ['groups', '[]', 'hostSources', '[]'],
      rule: HOST_SOURCE_CEL_CLUSTER_PARENT,
      message: 'namespace is required for kind AnsibleHost on a ClusterAnsibleInventory',
    },
  ],
  AnsibleRun: [
    {
      path: ['playbookRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
    {
      path: ['inventoryRef'],
      rule: REF_CEL_CLUSTER_KIND_NO_NAMESPACE,
      message: 'namespace must be absent when kind is a Cluster* kind',
    },
  ],
};

function buildCrd(descriptor: ResourceDescriptor): JSONSchemaNode {
  const specSchema = toJsonSchema(descriptor.specSchema);
  const statusSchema = toJsonSchema(descriptor.statusSchema);

  for (const extra of CEL_EXTRAS[descriptor.kind] ?? []) {
    applyCel(specSchema, extra);
  }
  preserveUnknownFields(specSchema);
  preserveUnknownFields(statusSchema);
  stripAdditionalPropertiesWithProperties(specSchema);
  stripAdditionalPropertiesWithProperties(statusSchema);
  annotateConditions(statusSchema);

  const listKind = `${descriptor.kind}List`;
  const shortName = descriptor.singular.replace(/^cluster/, 'c');

  return {
    apiVersion: 'apiextensions.k8s.io/v1',
    kind: 'CustomResourceDefinition',
    metadata: {
      name: `${descriptor.plural}.${API_GROUP}`,
    },
    spec: {
      group: API_GROUP,
      scope: descriptor.scope,
      names: {
        kind: descriptor.kind,
        listKind,
        plural: descriptor.plural,
        singular: descriptor.singular,
        shortNames: [shortName],
      },
      versions: [
        {
          name: API_VERSION,
          served: true,
          storage: true,
          subresources: { status: {} },
          additionalPrinterColumns: [
            ...(descriptor.printerColumns ?? []),
            { name: 'Age', jsonPath: '.metadata.creationTimestamp', type: 'date' },
          ],
          schema: {
            openAPIV3Schema: {
              type: 'object',
              properties: {
                spec: { type: 'object', ...specSchema },
                status: { type: 'object', ...statusSchema },
              },
            },
          },
        },
      ],
    },
  };
}

/**
 * The Helm chart (charts/a5e) applies CRDs as regular templates rather than via Helm's
 * special crds/ directory, specifically so `helm upgrade` picks up schema changes — this project's
 * CRDs change often during active development, and Helm's crds/ convention deliberately never
 * upgrades or deletes them. The `helm.sh/resource-policy: keep` annotation is the trade-off that
 * makes that safe: it stops `helm uninstall` from deleting the CRDs (and, transitively, every
 * AnsibleHost/AnsibleRun/etc. CR in the cluster) out from under a user who didn't ask for that.
 */
function writeHelmCrdTemplate(chartCrdsDir: string, fileName: string, crd: JSONSchemaNode) {
  const templated = {
    ...crd,
    metadata: {
      ...crd.metadata,
      annotations: {
        'helm.sh/resource-policy': '{{ .Values.crds.keep | ternary "keep" "" }}',
      },
    },
  };
  const body = YAML.stringify(templated).replace(
    `helm.sh/resource-policy: '{{ .Values.crds.keep | ternary "keep" "" }}'`,
    '{{- if .Values.crds.keep }}\n    helm.sh/resource-policy: keep\n    {{- end }}',
  );
  const content = `{{- if .Values.crds.install }}\n${body}{{- end }}\n`;
  writeFileSync(join(chartCrdsDir, fileName), content);
}

function main() {
  const outDir = join(import.meta.dir, '..', '..', '..', 'crds');
  mkdirSync(outDir, { recursive: true });
  const chartCrdsDir = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'charts',
    'a5e',
    'templates',
    'crds',
  );
  mkdirSync(chartCrdsDir, { recursive: true });

  const files: string[] = [];
  for (const descriptor of RESOURCE_DESCRIPTORS) {
    const crd = buildCrd(descriptor);
    const fileName = `${descriptor.plural}.yaml`;
    writeFileSync(join(outDir, fileName), YAML.stringify(crd));
    writeHelmCrdTemplate(chartCrdsDir, fileName, crd);
    files.push(fileName);
    console.log(`wrote crds/${fileName}`);
  }
  console.log(`wrote charts/a5e/templates/crds/*.yaml (${files.length} files)`);

  const kustomizationPath = join(outDir, 'kustomization.yaml');
  const kustomization = {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    resources: [...files, 'rbac/'],
  };
  mkdirSync(dirname(kustomizationPath), { recursive: true });
  writeFileSync(kustomizationPath, YAML.stringify(kustomization));
  console.log('wrote crds/kustomization.yaml');
}

main();
