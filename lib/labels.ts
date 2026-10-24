export const CHANNELS = {
  pos: "POS terminal",
  atm: "ATM",
  ecommerce: "E-commerce",
} as const;

export const SCHEMES = {
  visa: "Visa",
  mastercard: "Mastercard",
} as const;

export const STATUS = {
  draft: "Draft",
  uploaded: "Awaiting validation",
  processing: "Validating",
  complete: "Complete",
  failed: "Failed",
} as const;

export type Submission = {
  id: string;
  owner_id: string;
  entry_id: string;
  version: number;
  title: string;
  channel: keyof typeof CHANNELS;
  schemes: (keyof typeof SCHEMES)[];
  status: keyof typeof STATUS;
  created_at: string;
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
