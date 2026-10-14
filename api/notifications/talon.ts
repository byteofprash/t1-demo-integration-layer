import { handleInbound } from "../../lib/inbound.js";

export const POST = (req: Request) => handleInbound(req, "TalonOneNotification");
