export interface K8sObjectMeta {
  name: string;
  namespace?: string;
  generation?: number;
  resourceVersion?: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
    blockOwnerDeletion?: boolean;
  }>;
}

export interface CustomResource<TSpec, TStatus> {
  apiVersion: string;
  kind: string;
  metadata: K8sObjectMeta;
  spec: TSpec;
  status?: TStatus;
}
