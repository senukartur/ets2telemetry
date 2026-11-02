#include "../src/protocol.hpp"
#include <cmath>
#include <iostream>
int main() {
  winrt::init_apartment();
  try {
    auto parsed = media::command(R"({"version":1,"type":"snapshot","requestId":42,"selectedId":"s12"})");
    if (parsed.request != 42 || parsed.selected != L"s12") return 1;
    for (auto const& bad : {R"({"version":2,"type":"snapshot","requestId":1,"selectedId":null})", R"({"version":1,"type":"snapshot","requestId":0,"selectedId":null})", R"({"version":1,"type":"snapshot","requestId":1,"selectedId":"file:///bad"})"}) {
      bool rejected = false; try {media::command(bad);} catch (...) {rejected = true;} if (!rejected) return 1;
    }
    if (media::clean(L"A\nB\tC", 1024) != L"ABC" || media::clean(L"abcdef", 3) != L"abc") return 1;
    auto output = media::response(1); media::text(output, L"title", L"Трек \"one\" \\ two");
    if (media::JsonObject::Parse(output.Stringify()).GetNamedString(L"title") != L"Трек \"one\" \\ two") return 1;
    std::cout << "media protocol bounds and Unicode passed\n"; return 0;
  } catch (...) {return 1;}
}
