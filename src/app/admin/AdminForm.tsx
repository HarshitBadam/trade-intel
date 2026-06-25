"use client";

import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { CheckCircle2, AlertCircle, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { postCompany } from "./actions";
import { formSchema } from "./schema";
import { useState } from "react";

type Status = { ok: boolean; message: string };

export function AdminForm() {
  const [status, setStatus] = useState<Status | null>(null);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { ticker: "", company: "", logo: "" },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    setStatus(null);
    const result = await postCompany(values);
    setStatus(result);
    if (result.ok) {
      form.reset();
    }
  }

  return (
    <div className="flex min-h-[calc(100svh-3.5rem)] items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-white/60 bg-white/80 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-card/85">
        <div className="p-8 sm:p-10">
          <div className="mb-8 flex items-center gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-violet-600/25">
              <Building2 className="size-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Add Company
              </h1>
              <p className="text-sm text-muted-foreground">
                Register a company so its name and logo appear across
                TradeIntel.
              </p>
            </div>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="ticker"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ticker</FormLabel>
                    <FormControl>
                      <Input placeholder="AAPL" {...field} />
                    </FormControl>
                    <FormDescription>
                      The stock symbol, 1 to 5 letters.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="company"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Company name</FormLabel>
                    <FormControl>
                      <Input placeholder="Apple Inc." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="logo"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Logo URL</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="https://logo.clearbit.com/apple.com"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      Public https URL of the company logo.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex items-center justify-between gap-4 pt-2">
                {status ? (
                  <p
                    className={`flex items-center gap-1.5 text-sm ${
                      status.ok
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive"
                    }`}
                  >
                    {status.ok ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      <AlertCircle className="size-4" />
                    )}
                    {status.message}
                  </p>
                ) : (
                  <span />
                )}
                <Button
                  type="submit"
                  disabled={form.formState.isSubmitting}
                  className="border-0 bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-lg shadow-violet-600/25 transition-all hover:from-indigo-500 hover:to-violet-500"
                >
                  {form.formState.isSubmitting ? "Saving..." : "Add company"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
