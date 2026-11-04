
this service allows the dynamic setup of multip providers for managing vouchers system 

it works as follow 
- the administrator setups the list of providres 
  - provider name 
  - authentication approach 
  - meta
  - admin can 
    - list the providers
    - update a provider each details, name, authentication approach
    - manage a provider meta (paramters list), key, type, value
    - block, unblock provider (prevent from being used or purchase from)
    - delete providers with no relations to service products 
    - add new provider 
      - name 
      - authentication approach, one of 
        - no auth 
        - permanant token, which will require entering the token as string
        - refresh token with new access token each refresh, which will require the refresh token string, and period to refresh, and extract string for access token 
        - user name and password to refresh token, extract string, period, username, and password
        - basic auth, username and password 
        - the authentication will be use to build provider use api map that will be used to fetch either cached use api tool or construct one for the provider 
        - and then use it to perform requests based on it as 
          - request method 
          - request body 
          - request query 
          - request url 
          - and ofcource request headers in addition to the headers that will be set automatically by the request method on the contructed use api tool 

    - setup voucher purchase query stack (a provider with empty query stack wont be used); 
      - list queries  
      - reorder them (lower index will be ran first, default sorting in listing is by order)
      - add to them 
        - method
        - url (full)
      - manage a query parameters 
        - place (headers, query, body)
        - type PROVIDER_META, REQUEST_META, AMOUNT, PRICE, FACE_VALUE, PREVIOUS_REQUEST_DATA (will throw if its the first), SERVICE_ADDITIONAL_DATA (form attached data if srevice requires it for example if the service type is bill payment and you need to provide the meter number or something)
        - key (recursive set key)
        - selector (for request data, rovider meta, or the request meta)
      - manage voucher extraction data from purchase result
        - secretSelector (if its a secret based service)
        - idSlector/serialNumberSelector (may not be needed)
        - meta 
          - key (key to be stored in meta (recursive set)); 
          - selector (to extract it from result data)
          - // type is not necessary its up to the request response 

a sample code of how the dynamic authenticaiton model will may look like 
```ts


type JsonBase = string | number | boolean | JsonObject | JsonList
type JsonList = JsonBase[];
type JsonObject = {
    [key: string]: JsonBase
}


const numberRegex = /^[0-9]+$/;
function recursiveSet(object: any, setter: string | string[], value: any) {
    if (!setter || !setter.length) {
        throw new Error("setter string or list cant be empty")
    }
    const setterList = typeof setter == "string" ? setter.split(".") : setter;

    const lastSetter = setterList.pop()!;
    let targetObject = object;
    for (let i = 0; i < setterList.length; i++) {
        const setter = setterList[i]!;
        const nextSetter = (i == (setterList.length - 1) ? lastSetter : setterList[i + 1])!
        if(!targetObject[setter]){
          if (numberRegex.test(nextSetter)) {
            targetObject[setter] = []
          } else {
              targetObject[setter] = {}
          }
        }
        targetObject = targetObject[setter]
    }
    targetObject[lastSetter] = value;
}


const recursiveSelectWithForLoop = (target: any, selector: string | string[]) => {
    if (!selector || !selector.length || target === undefined || target === null) {
        return target;
    }

    const selectorList = typeof selector == 'string' ? selector.split(".") : selector;



    let currentTarget = target;
    for (const selector of selectorList) {
        currentTarget = currentTarget[selector];
        if (currentTarget === undefined || currentTarget === null) {
            return currentTarget
        }
    }
    return currentTarget;
}

const recursiveSelector = (target: any, selector: string | string[]) => {
    if (!selector || !selector.length || target === undefined || target === null) {
        return target;
    }

    const selectorList = typeof selector == "string" ? selector.split(".") : selector;

    const currentTarget = target[selectorList[0]!]

    return recursiveSelector(currentTarget, selectorList.slice(1))
}




type CompileUrlOptions = {
    /**
     * indices : a[0]=x&a[1]=y   (qs default, safest for arrays of objects)
     * brackets: a[]=x&a[]=y     (axios default)
     * repeat  : a=x&a=y
     */
    arrayFormat?: "indices" | "brackets" | "repeat";
    /** Encode the brackets as %5B %5D (qs default). Express parses both forms. */
    encodeBrackets?: boolean;
};

export const compileUrl = (
    url: string,
    query?: JsonObject,
    options: CompileUrlOptions = {},
): string => {
    if (!query) {
        return url
    }


    const { arrayFormat = "indices", encodeBrackets = false } = options;

    const open = encodeBrackets ? "%5B" : "[";
    const close = encodeBrackets ? "%5D" : "]";
    const enc = encodeURIComponent;

    const parts: string[] = [];

    const walk = (prefix: string, value: JsonBase | null | undefined): void => {
        // Skip values that have no representation in a query string
        if (value === undefined || value === null) return;

        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                const key =
                    arrayFormat === "indices"
                        ? `${prefix}${open}${index}${close}`
                        : arrayFormat === "brackets"
                            ? `${prefix}${open}${close}`
                            : prefix;
                walk(key, item);
            });
            return;
        }

        if (typeof value === "object") {
            for (const [k, v] of Object.entries(value)) {
                walk(`${prefix}${open}${enc(k)}${close}`, v);
            }
            return;
        }

        parts.push(`${prefix}=${enc(String(value))}`);
    };

    if (query) {
        for (const [k, v] of Object.entries(query)) {
            walk(enc(k), v);
        }
    }

    if (!parts.length) return url;

    // Keep any #hash at the end, and respect an existing ?query in the url
    const hashIndex = url.indexOf("#");
    const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex);

    const separator = !base.includes("?")
        ? "?"
        : base.endsWith("?") || base.endsWith("&")
            ? ""
            : "&";

    return `${base}${separator}${parts.join("&")}${hash}`;
};


class ApiConsumer<T> {
    auth: T | null = null;
    refreshTimer: ReturnType<typeof setInterval> | null = null;
    clearRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer)
        }
    }
    stop = () => {
        this.clearRefresh();
    }



    setRefresh(props?: {
        period: number;
        onRefresh: (props: {
            oldAuth: T | null;
            updateAuth: (newAuth: T) => void;
        }) => Promise<void>
    }) {
        this.clearRefresh();
        if (props) {
            this.refreshTimer = setInterval(async () => {
                try {
                    await props.onRefresh?.({
                        oldAuth: this.auth,
                        updateAuth: (newAuth) => {
                            this.auth = newAuth;
                        },
                    })
                } catch (error) {
                    console.error("failed to refresh authentication")
                }
            }, props.period)
        }

    }

    onAuth: (setRefresh: InstanceType<typeof ApiConsumer<T>>["setRefresh"]) => Promise<T> | T;
    isAuthError: null | ((error: any) => boolean) = null;
    applyHeaders: ((auth: T) => {
        [key: string]: string;
    }) | null = null;
    constructor(props: {
        onAuth: (setRefresh: InstanceType<typeof ApiConsumer<T>>["setRefresh"]) => Promise<T> | T;
        isAuthError?: (error: any) => boolean;
        applyHeaders?: (auth: T) => {
            [key: string]: string;
        }
    }) {
        this.onAuth = props.onAuth;
        this.isAuthError = props.isAuthError ?? null;
        this.applyHeaders = props.applyHeaders ?? null;
    }

    async updateAuth() {
        const newAuth = await this.onAuth(this.setRefresh);
        this.auth = newAuth;
        return newAuth;
    }

    async getAuth() {
        if (this.auth) {
            return this.auth;
        }
        return await this.updateAuth()
    }

    async useApi<R>(callback: (auth: T) => Promise<R>) {
        let auth = await this.getAuth();
        try {
            return await callback(auth)
        } catch (error: any) {
            if (typeof this.isAuthError != "function" || this.isAuthError(error)) {
                auth = await this.updateAuth();
                return await callback(auth);
            } else {
                throw error;
            }
        }
    }

    async request<R>(props: {
        method: "POST" | "GET" | "PATCH" | "DELETE" | "PUT",
        query?: JsonObject;
        body?: JsonObject;
        url: string;
        headers?: {
            [key: string]: string
        }
    }) {
        return this.useApi<R>(async (auth) => {
            const headers = new Headers()
            if (props.headers) {
                for (const key in props.headers) {
                    headers.set(key, props.headers[key]!)
                }
            }
            const appliedHeaders = this.applyHeaders?.(auth);
            if (appliedHeaders) {
                for (const key in appliedHeaders) {
                    headers.set(key, appliedHeaders[key]!)
                }
            }
            const result = await fetch(compileUrl(props.url, props.query), {
                method: props.method,
                headers,
                body: props.body ? JSON.stringify(props.body) : undefined,
            })
            const data = await result.json()
            if (result.ok) {
                return data as R;
            }
            throw {
                error: data,
                status: result.status
            }
        })
    }
}

type Provider = {
    providerId: number;

    authenticationMethod: "No" | "Perma" | "RefreshNew" | "UsernamePassword" | "basicAuth"

    meta?: JsonObject;

    username?: string;
    password?: string;

    permanentToken?: string;

    refreshUrl?: string;
    refreshToken?: string;
    refreshNewTokenSelector?: string
    refreshMethod?: "POST" | "GET" | "DELETE" | "PUT" | "PATCH"
    refreshParameters?: {
        paramterId: number;
        type: "META" | "REFRESH_TOKEN",
        key: string; // example auth.refresh_token 
        metaSelector: string; // requestId
        place: "HEADERS" | "BODY" | "QUERY"
    }[]




    basicAuthUsername?: string;
    basicAuthPassword?: string;
    refreshPeriodInMs?: number;
    name: string;
}


/**
 * assuming getting provider data from database; 
 */
const getProviderData = async (id: number) => {
    const p: Provider = {
        name: "Anis",
        authenticationMethod: "Perma",
        permanentToken: "someSecretToken",
        providerId: 1,
    }
    return p
}

const providersApiConsumersMap: Map<number, ApiConsumer<any>> = new Map();
const getProviderApiConsumer = async (providerId: number) => {
    const providerData: Provider = await getProviderData(providerId);
    const existingConsumer = providersApiConsumersMap.get(providerId);
    if (existingConsumer) {
        return existingConsumer
    }

    let consumer: ApiConsumer<any>;
    if (providerData.authenticationMethod == "No") {
        consumer = new ApiConsumer<{}>({
            async onAuth(setRefresh) {
                return {}
            },
            isAuthError(error) {
                return false;
            },
        })
    } else if (providerData.authenticationMethod == "Perma") {
        consumer = new ApiConsumer<string>({
            async onAuth(setRefresh) {
                return providerData.permanentToken!;
            },
            isAuthError(error: {
                status: number;
                error: any;
            }) {
                return [401, 403].includes(error.status);
            },
            applyHeaders(auth) {
                return {
                    Authorization: `Bearer ${auth}`
                }
            }
        })
    } else if (providerData.authenticationMethod == "RefreshNew") {
        consumer = new ApiConsumer<string>({
            async onAuth(setRefresh) {
                const getToken = async () => {
                    const headersObject: JsonObject = {};
                    const body: JsonObject = {};
                    const query: JsonObject = {};

                    const getTargetObject = (place: "HEADERS" | "BODY" | "QUERY") => {
                        switch (place) {
                            case "BODY":
                                return body;
                                break;
                            case "HEADERS":
                                return headersObject;
                                break;
                            case "QUERY":
                                return query;
                                break;
                        }
                    }
                    const getValue = (type: "META" | "REFRESH_TOKEN", selector?: string) => {
                        if (type == "META") {
                            return recursiveSelectWithForLoop(providerData.meta ?? {}, selector!)
                        }
                        return providerData.refreshToken!;
                    }

                    for (const parameter of providerData.refreshParameters ?? []) {
                        recursiveSet(getTargetObject(parameter.place), parameter.key, getValue(parameter.type, parameter.metaSelector))
                    }
                    const headers = new Headers();
                    for (const key in headersObject) {
                        headers.set(key, String(headersObject[key]))
                    }

                    const result = await fetch(compileUrl(providerData.refreshUrl!, Object.keys(query).length ? query : undefined), {
                        method: providerData.refreshMethod,
                        headers,
                        body: Object.keys(body).length ? JSON.stringify(body) : undefined
                    })
                    const data = await result.json()
                    if (!result.ok) {
                        throw {
                            error: data,
                            status: result.status,
                        }
                    }
                    const token = recursiveSelectWithForLoop(data, providerData.refreshNewTokenSelector!);
                    return token
                }

                setRefresh({
                    period: providerData.refreshPeriodInMs ?? 30 * 60_000,
                    async onRefresh(props) {
                        props.updateAuth(await getToken())
                    },
                })

                return await getToken()
            },
            isAuthError(error: {
                status: number;
                error: any;
            }) {
                return [401, 403].includes(error.status);
            },
            applyHeaders(auth) {
                return {
                    Authorization: `Bearer ${auth}`
                }
            }
        })
    }
    // an so on for other authenticaiton approaches.....
    providersApiConsumersMap.set(providerId, consumer!); 
    return consumer!
}

const updateProviderAuthentication = (props: {
    providerId: number; 
    authMethod: ".... as mentioned above"
    // rest of update paramters
})=>{
    // validate the parameters then update the database records then delete the cached api consumer so it needs to be set and or emit redis event that other instances can listen to to reset the cached api consumer (for now no need for redis for we will be using one instance)
    const consumer = providersApiConsumersMap.get(props.providerId); 
    if(consumer){
      consumer.stop(); 
      providersApiConsumersMap.delete(props.providerId)
    }
}
```


- then setup the listings 
  - each listing could be related to a parent or belong directly to the root by having no parents 
  - a listing item could be a sub-category (which would have children, sub listing) or a direct service listing 
  - in addition a listing item have a name in arabic, and english, also have image (optional) from assets 
  - a listing item also have priority index which allows the list to show with proper sorting 
  - in summary the user/admin in listing screen can see the root listing items, add to them or click on a sub-category listing item which will open a similar screen but for the sub-category listing which allows recursive adding and selecting 
  - the user can delete a listing item if it is a service or an empty sub-category 

- assets setup
  - assets are images which could be png/svg with a name for identification 
  - in summary the user can see the assets list can add to them or can delete them if they have no relation to listing items, in addition the user can view them in detail with a proper image viewer 
  - user can also exchange an asset by updating the file content 
  - the assets are uploaded and managed with formData with proper validation on the file size limits and type on client and server side


- admin can manage permanent access tokens for accessing the listing and voucher purchase apis
  - list tokens
  - create tokens 
  - delete tokens 
  - copy tokens 
  - setup ip white list for each token (if a flag setup to be allow white listed ip only is checked)
  - list, delete, update, add to ip white list

- service management 
  - list, update, deelete (unlinked, no providers), and add services
  - add 
    - name 
    - type (secret, bill)
  - manage each service details,
    - view recent history transacitons
    - setup service form (enabled it disabled it)
      - define form fields, list them, update them, delete them, or add to them 
        - a form field contains 
          - key (key in sumitted body)
          - type (date, date-time, time, number, string, fromList(listed items(value, label_en, label_ar)))
          - label_en
          - label_ar
          - additional rules descriptors (may not be implemented)
            - zod rule contruction sequence
            
    - manage service meta
      - key
      - type 
      - value
    - update certain details
    - block purchses (and prevent viewing in listings)
    - unblock 
    - list, add, update, delete provider listing
      - list providers 
      - add provider 
        - choose from exisitng not already selected providers 
        - set priority index (the higher the more likely it selected if the prices match)
      - manage a provider products listing (if a provider has an empty list for a service it wont be selected at all)
        - there is two types of listing sources fixedList, or ApiList
          - fixed listing is a list of products with following prarameters 
            - amount 
            - price
            - face value (stirng)
            - meta list, update, add, delete
              - key
              - type 
              - value
          - api list requires 
            - method 
            - url
            - list extractor selector recursive select (from result)
            - and to extract product listing details we need 
              - amount selector 
              - face value selectors (multiple to join them with space and order them)
              - price selector 
              - meta selector (important to be passed to the request meta and purchase voucher successfully)
                - key
                - selector 
            - parameters (optional list of paramters that can be managed), list, add, update, delete
              - type PROVIDER_META, AUTH_TOKEN (will throw if incompatible auth method),
              - key
              - place (headers, body, query) 
      
- set of basic pages and routes for listing transactions history, view system logs, view stats, ...manages users 

- voucher purchase api (accessed view the bearer tokens managed above); 
  - list services and sub categories (view root lists)
  - list sub-category (return the sub list items of that category)
  - listed services (in sub category or root), must have 
    - valid list of providers (that are not blocked)
    - service is not blocked
  - get service product listing (only service id is required)
    - first we collect provider product lists (that providers are not blocked and )
      - in a middleware we check if the service is blocked then we throw
      - we first retrieve the providers list from database that are not blocked
      - if there is no providers we throw (404) service has no providers
      - we filter out api listed providers 
        - in an async cuncurrency sized pool we await out and collect product listing and attach them to each corresponding provider 
      - as for fixed listed providers they are already listed via the above query 
      - we compile a product listing (object) map<productListingAmount, {
        amount: number; 
        providers: list of providers that provide that listing with the provider id, provider priority index (from the lisitng),  servicer-provider id (the id of the provider in the service listing), srevice id, product listing meta, price, amount and face value
      }>
      - then for each value of the map we sort out the providers two times 
        - first based on the priority index (higher first)
        - second we sort based on the price (lower first)
      - we create final listing that has only on product listing and filter products listing with no providers (due to errors or other reasons)
      - we return that list and service details with its form construct if it has any
      - in that way we are always winning 

- voucher purchase api 
  - we need 
    - service provider id 
    - product listing meta 
    - amount 
    - price 
    - face value 
    - form_data (if service require them)
  - we make sure the provider and the service is not blocked 
  - we get the provider purchase query queue/stack 
  - in a loop we build and perform each query untill we get the last result 
  - we extract the voucher result data as based on the provider info 
  - we log everything in the database including the incoming request token and ip and additional parameters for identification and sorting later 
  - we return the extracted result 

- additional apis to list transactions based on cliend data may be specified later

