//evals.ts

import { EvalConfig } from 'mcp-evals';
import { openai } from "@ai-sdk/openai";
import { grade, EvalFunction } from "mcp-evals";

const queryEval: EvalFunction = {
    name: "query Tool Evaluation",
    description: "Tests the functionality of running a read-only BigQuery SQL query",
    run: async () => {
        const result = await grade(openai("gpt-4"), "What is the total number of lines in the bigquery-public-data.samples.shakespeare table using a read-only BigQuery SQL query?");
        return JSON.parse(result);
    }
};

const config: EvalConfig = {
    model: openai("gpt-4"),
    evals: [queryEval]
};
  
export default config;
  
export const evals = [queryEval];