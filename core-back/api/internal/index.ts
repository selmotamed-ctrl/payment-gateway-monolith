import { adminInternalRouter } from "./admin";
import { checkoutInternalRouter } from "./checkout";
import { merchantInternalRouter } from "./merchant";

/**
 * The internal channel routers.
 *
 * The live router is mounted in `core-back/api/index.ts`, which binds every
 * namespace to the client certificate that may call it. This module only
 * exports the channel routers themselves.
 */
export { adminInternalRouter, checkoutInternalRouter, merchantInternalRouter };
