export type AppEnvironment = 'development' | 'staging' | 'production';

export type ApiErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string;
  };
};
