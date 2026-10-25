export const apiErrorSymbol = Symbol("api-error");
import z from "zod"
import type { $ZodType, $ZodTypeInternals } from "zod/v4/core";
export const isApiError = (error: any): error is ApiError =>{
    return error?.__symbol === apiErrorSymbol; 
}


export class ApiError extends Error {
  __symbol = apiErrorSymbol;

  error: string;
  errors: undefined | string[];
  code: string;
  statusCode: number;
  data?: any;
  constructor(props: {
    error: string;
    data?: any;
    statusCode: number;
    errors?: string[];
    code: string;
  }) {
    super();
    this.error = props.error;
    this.data = props.data;
    this.code = props.code;
    this.statusCode = props.statusCode;
    this.errors = props.errors;
  }
}

export const errorCodePrefixer = (prefix: string) => {
  prefix = prefix.toUpperCase().replaceAll(" ", "_");

  return (code: string) => {
    code = code.toUpperCase().replaceAll(" ", "_");
    return `${prefix}${code}`;
  };
};



export const parseOrThrow = async <T extends Readonly<{ [k: string]: $ZodType<unknown, unknown, $ZodTypeInternals<unknown, unknown>>; }>>(body: any, schema: z.ZodObject<T>)=>{
  const result = await z.safeParseAsync(schema, body)
  if(result.success){
    return result.data; 
  }

  throw new ApiError({
    statusCode: 400, 
    code: "INVALID_BODY",
    error: "invalid request data", 
    data: result.error,      
  })
}