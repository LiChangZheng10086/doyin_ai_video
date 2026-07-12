import { Converter } from "opencc-js/t2cn";

const convertToSimplified = Converter({ from: "t", to: "cn" });

export function toSimplifiedChinese(value: string) {
  return convertToSimplified(value);
}

export function simplifyChineseValue<T>(value: T): T {
  if (typeof value === "string") return toSimplifiedChinese(value) as T;
  if (Array.isArray(value)) return value.map(simplifyChineseValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, simplifyChineseValue(item)])
    ) as T;
  }
  return value;
}
