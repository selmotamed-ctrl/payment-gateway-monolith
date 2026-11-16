import { sandboxCoreBackUrls } from "./env";
import { ApiError } from "./error";

/** v38: the `sbx_` link prefix is the only public marker of the Sandbox plane. */
export const isSandboxLinkKey = (linkKey: string): boolean => linkKey.startsWith("sbx_");

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

export const linkTargetUrls = (linkKey: string): string[] | undefined =>
  isSandboxLinkKey(linkKey) ? requireSandboxCoreBackUrls() : undefined;
