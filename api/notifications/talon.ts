import { handleInbound } from "../../lib/inbound";

export const POST = (req: Request) => handleInbound(req, "TalonOneNotification");
