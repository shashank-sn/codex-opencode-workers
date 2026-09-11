export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function safeError(error) {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message };
  }
  return { code: "WORKER_ERROR", message: "The OpenCode worker could not complete safely." };
}
