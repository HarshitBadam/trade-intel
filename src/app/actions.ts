import {NextResponse} from "next/server";
import { DataAPIClient } from '@datastax/astra-db-ts';
import { env } from "process";

const BASE_API_URL = "https://api.langflow.astra.datastax.com";
const LANGFLOW_ID = "62470d86-6c8f-459c-8ce6-86f4960f103d";
const FLOW_ID = "1e3bd3f3-63c3-4e06-9b0a-2fee18d494e1";

const client = new DataAPIClient(process.env.ASTRA_DB_APPLICATION_TOKEN);

const db1 = client.db(process.env.ASTRA_DB_API_ENDPOINT as string)

export async function getSummary(message: string) {
    try {

        const endpoint = FLOW_ID
        const output_type = "chat"
        const input_type = "chat"
        const tweaks = {}

        const apiUrl = `${BASE_API_URL}/lf/${LANGFLOW_ID}/api/v1/run/${endpoint}`;

        const payload = {
            input_value: message,
            output_type,
            input_type,
            tweaks,
        };

        const headers = {
            Authorization: `Bearer ${process.env.ASTRA_DB_APPLICATION_TOKEN}`,
            "Content-Type": "application/json",
        };

        const response = await fetch(apiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
        });

        return await response.json()
    } catch (error) {
        return "FAIL"
    }
}

export async function getCompanies(){
    const collection = db1.collection("companies");
    const companies = await collection.find({});
    return companies;
}