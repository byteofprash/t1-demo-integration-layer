import { preflight, withCors } from "../../lib/cors.js";
import { handleInbound } from "../../lib/inbound.js";

export const POST = async (req: Request) => withCors(await handleInbound(req, "TalonOneWebhook"));
export const OPTIONS = () => preflight();
