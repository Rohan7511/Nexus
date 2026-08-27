#include <node.h>
namespace {
void Hi(const v8::FunctionCallbackInfo<v8::Value>& a){
  a.GetReturnValue().Set(v8::String::NewFromUtf8(a.GetIsolate(),"hi-from-raw-abi").ToLocalChecked());
}
void Init(v8::Local<v8::Object> e){ NODE_SET_METHOD(e,"hi",Hi); }
}
NODE_MODULE(NODE_GYP_MODULE_NAME, Init)
