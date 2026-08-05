import type { LeafAppPlugin } from "@redbamboo/utility"
import { DoctorSettingsPanel } from "./DoctorSettingsPanel"

export const plugin: LeafAppPlugin = {
  id: "doctor",
  settingsPanel: { Component: DoctorSettingsPanel },
}
