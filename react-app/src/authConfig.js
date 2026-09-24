export const msalConfig = {
  auth: {
    clientId: "668c6b31-7f47-4442-ab5d-2defdf8fb87c",
    authority: "https://login.microsoftonline.com/b1e769c7-78fc-4eb9-a371-2c14cbcc07af",
    redirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
};

// Scope for our own API - requesting this triggers acquisition of a token
// APIM can validate, rather than a generic Microsoft Graph token.
export const apiRequest = {
  scopes: ["api://5fcba1ce-8186-4dbb-9b35-e2f07ee74db6/access_as_user"],
};

// All calls go through APIM; the App Service rejects anything that didn't.
export const API_BASE_URL = "https://ustrat-apim.azure-api.net/supply-chain";
