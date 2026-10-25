import cors from "cors"; 
import express, { type NextFunction, type Request, type Response } from "express"; 
import { apiRouter } from "./api";
import { env } from "./lib/env";
import { ApiError, apiErrorSymbol, isApiError } from "./lib/error";
import { requestLoggerMiddleware } from "./lib/requestLogger";

const run = async ()=>{
    const app = express(); 
    app.use(express.json())
    app.use(express.urlencoded({
        extended: true,
    }))
    app.use(cors())
    
    app.use(requestLoggerMiddleware)


    app.get("/health", (_, response)=>{
        return response.json({
            msg: "OK"
        })
    })

    app.use("/api", apiRouter)
    app.use((error: any, request: Request, response: Response, next: NextFunction)=>{
        console.error(error); 
        if(response.headersSent){
            return
        }
        let apiError: ApiError
        if(!isApiError(error)){
            apiError = new ApiError({
                code: 'SERVER_ERROR', 
                statusCode: 500, 
                data: error, 
                error: "unknown error",
            })
        }else{
            apiError = error; 
        }

        response.status(apiError.statusCode).json(apiError)
    })
    console.log("Server will run on port", env.PORT)
    app.listen(env.PORT)
}


await run()