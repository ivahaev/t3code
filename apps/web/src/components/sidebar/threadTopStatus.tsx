import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarThreadStatus } from "../Sidebar.logic";

const TOP_STATUS_ICONS = {
  working: CircleDashedIcon,
  waiting: CircleDotDashedIcon,
  input: MessageCircleQuestionIcon,
  request: UserRoundIcon,
  approval: ShieldQuestionIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  woke: AlarmClockIcon,
} as const;

export type ThreadTopStatus = {
  readonly label: string;
  readonly icon: keyof typeof TOP_STATUS_ICONS;
  readonly className: string;
};

export function TopStatusIcon(props: { icon: keyof typeof TOP_STATUS_ICONS; className: string }) {
  const Icon = TOP_STATUS_ICONS[props.icon];
  return <Icon aria-hidden className={cn("shrink-0", props.className)} />;
}

/** The status a thread row shows: the same words and icons wherever a thread is listed. */
export function resolveThreadTopStatus(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly goalActive: boolean;
}): ThreadTopStatus | null {
  const { status } = input;
  switch (status) {
    case "preparing":
    case "working":
      return {
        label: status === "preparing" ? "Setting up" : input.goalActive ? "Goal" : "Working",
        icon: "working",
        className: "text-info-foreground",
      };
    case "waiting":
      return { label: "Waiting", icon: "waiting", className: "text-muted-foreground" };
    case "approval":
      return { label: "Approval", icon: "approval", className: "text-warning-foreground" };
    case "input":
      return {
        label: "Input",
        icon: "input",
        className: "text-indigo-600 dark:text-indigo-300",
      };
    case "request":
      return { label: "Request", icon: "request", className: "text-guest-foreground" };
    case "limited":
      return { label: "Limited", icon: "failed", className: "text-warning-foreground" };
    case "failed":
      return { label: "Failed", icon: "failed", className: "text-error-foreground" };
  }
  if (input.isWoke) return { label: "Woke", icon: "woke", className: "text-warning-foreground" };
  if (input.isUnread) return { label: "Done", icon: "done", className: "text-success-foreground" };
  return null;
}
