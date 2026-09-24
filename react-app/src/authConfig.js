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
// the API can validate, rather than a generic Microsoft Graph token.
export const apiRequest = {
  scopes: ["api://5fcba1ce-8186-4dbb-9b35-e2f07ee74db6/access_as_user"],
};

export const API_BASE_URL = "https://ustrat-operational-api-crbubedtc3b7eah5.westus2-01.azurewebsites.net";
