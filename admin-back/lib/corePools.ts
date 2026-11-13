import { sandboxCoreBackUrls } from "./env";
import { ApiError } from "./error";

export const requireSandboxCoreBackUrls = (): string[] => {
  const urls = sandboxCoreBackUrls();
  if (!urls || urls.length === 0) {
    throw new ApiError(
      503,
      "SANDBOX_NODE_UNAVAILABLE",
      "The Sandbox environment is not configured on this gateway",
    );
  }
  return urls;
};
