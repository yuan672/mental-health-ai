export type AccountDeletionRequest = {
  operationId: string;
  currentPassword: string;
  acknowledgeIrreversible: true;
};
