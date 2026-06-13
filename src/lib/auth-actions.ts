"use server";

import { signIn, signOut } from "@/auth";

export async function signInWith(provider: "google" | "apple") {
  await signIn(provider, { redirectTo: "/" });
}

export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
