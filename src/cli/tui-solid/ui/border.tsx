import type { BorderSides } from "@opentui/core";

export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};

export const SplitBorder = {
  border: ["left", "right"] as BorderSides[],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
};
